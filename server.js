#!/usr/bin/env node
'use strict';

/**
 * Traceroute visualizer - zero dependency server.
 *
 *   GET /                        -> static UI from ./public
 *   GET /api/health              -> { ok, traceroute, platform }
 *   GET /api/trace               -> full JSON result (waits for completion)
 *   GET /api/trace/stream        -> Server-Sent Events, one message per hop
 *
 * Query params: host (required), maxHops, probes, timeout, protocol
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 4180;
const BIND = process.env.BIND || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_WIN = process.platform === 'win32';
const TRACEROUTE_BIN =
  process.env.TRACEROUTE_BIN || (IS_WIN ? 'tracert' : 'traceroute');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ parsing */

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,}$/;

function looksLikeIp(token) {
  if (IPV4_RE.test(token)) return true;
  return IPV6_RE.test(token) && token.includes(':');
}

/** Parse a single traceroute hop line into a hop object. */
function parseHopLine(line) {
  const m = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (!m) return null;

  const hop = Number(m[1]);
  const tokens = m[2].trim().split(/\s+/);
  const probes = [];
  let pendingIp = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '*') {
      probes.push({ ip: null, rtt: null });
      pendingIp = null;
      continue;
    }
    if (looksLikeIp(t)) {
      pendingIp = t;
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(t) && tokens[i + 1] === 'ms') {
      probes.push({ ip: pendingIp, rtt: Number(t) });
      i += 1;
    }
  }

  if (!probes.length) return null;

  const rtts = probes.filter((p) => p.rtt !== null).map((p) => p.rtt);
  const ip = probes.find((p) => p.ip)?.ip || null;

  return {
    hop,
    ip,
    probes,
    responded: rtts.length > 0,
    min: rtts.length ? Math.min(...rtts) : null,
    max: rtts.length ? Math.max(...rtts) : null,
    avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
  };
}

/** Best effort extraction of the resolved target from the traceroute banner. */
function parseHeader(line) {
  const m = /traceroute to (\S+)(?: \(([^)]+)\))?/.exec(line);
  if (!m) return null;
  return { name: m[1], ip: m[2] || (looksLikeIp(m[1]) ? m[1] : null) };
}

function summarize(meta, hops, extra = {}) {
  const responded = hops.filter((h) => h.responded);
  const allRtts = responded.flatMap((h) => h.probes.filter((p) => p.rtt !== null).map((p) => p.rtt));
  return {
    host: meta.host,
    target: meta.target || null,
    hops,
    stats: {
      hopCount: hops.length,
      respondedHops: responded.length,
      timeouts: hops.length - responded.length,
      min: allRtts.length ? Math.min(...allRtts) : null,
      max: allRtts.length ? Math.max(...allRtts) : null,
      avg: allRtts.length ? allRtts.reduce((a, b) => a + b, 0) / allRtts.length : null,
      reached:
        hops.length > 0 &&
        Boolean(meta.target?.ip) &&
        hops.some((h) => h.ip === meta.target.ip),
    },
    ...extra,
  };
}

/* ------------------------------------------------------------- validation */

function validateQuery(searchParams) {
  const host = (searchParams.get('host') || '').trim();
  if (!host) return { error: 'Missing "host" parameter.' };
  if (host.length > 253) return { error: 'Host is too long.' };
  if (host.startsWith('-')) return { error: 'Host may not start with "-".' };
  if (!/^[a-zA-Z0-9._:\-\[\]]+$/.test(host)) {
    return { error: 'Host contains unsupported characters.' };
  }

  const clamp = (raw, min, max, fallback) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const protocolRaw = (searchParams.get('protocol') || 'udp').toLowerCase();
  const protocol = ['udp', 'icmp', 'tcp'].includes(protocolRaw) ? protocolRaw : 'udp';

  return {
    host,
    maxHops: clamp(searchParams.get('maxHops'), 1, 64, 30),
    probes: clamp(searchParams.get('probes'), 1, 5, 3),
    timeout: clamp(searchParams.get('timeout'), 1, 5, 2),
    protocol,
  };
}

function buildArgs(opts) {
  if (IS_WIN) {
    return ['-h', String(opts.maxHops), '-w', String(opts.timeout * 1000), opts.host];
  }
  return [
    '-n',
    '-q', String(opts.probes),
    '-w', String(opts.timeout),
    '-m', String(opts.maxHops),
    '-P', opts.protocol,
    opts.host,
  ];
}

/* ------------------------------------------------------------------ routes */

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function handleTrace(req, res, opts) {
  const started = Date.now();
  const child = spawn(TRACEROUTE_BIN, buildArgs(opts), { stdio: ['ignore', 'pipe', 'pipe'] });
  const hops = [];
  let target = null;
  let buffer = '';
  let stderr = '';

  const onLine = (line) => {
    if (!target) {
      const header = parseHeader(line);
      if (header) target = header;
    }
    const hop = parseHopLine(line);
    if (hop) hops.push(hop);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(onLine);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    // traceroute prints its banner on stderr when stdout is not a TTY
    if (!target) {
      const header = parseHeader(stderr);
      if (header) target = header;
    }
  });

  child.on('error', (err) => {
    sendJson(res, 500, { error: `Failed to run ${TRACEROUTE_BIN}: ${err.message}` });
  });

  child.on('close', (code) => {
    if (buffer.trim()) onLine(buffer);
    if (!target) {
      const header = parseHeader(stderr);
      if (header) target = header;
    }
    if (!hops.length && stderr.trim()) {
      return sendJson(res, 502, { error: stderr.trim().split('\n')[0] });
    }
    sendJson(res, 200, summarize({ host: opts.host, target }, hops, {
      options: opts,
      exitCode: code,
      durationMs: Date.now() - started,
      command: `${TRACEROUTE_BIN} ${buildArgs(opts).join(' ')}`,
    }));
  });

  req.on('close', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
}

function handleTraceStream(req, res, opts) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const started = Date.now();
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const child = spawn(TRACEROUTE_BIN, buildArgs(opts), { stdio: ['ignore', 'pipe', 'pipe'] });
  const hops = [];
  let target = null;
  let buffer = '';
  let stderr = '';
  let closed = false;

  const finish = (event, data) => {
    if (closed) return;
    closed = true;
    send(event, data);
    res.end();
  };

  const onLine = (line) => {
    if (!target) {
      const header = parseHeader(line);
      if (header) {
        target = header;
        send('header', { target, host: opts.host, options: opts });
      }
    }
    const hop = parseHopLine(line);
    if (hop) {
      hops.push(hop);
      send('hop', hop);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(onLine);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    // traceroute prints its banner on stderr when stdout is not a TTY
    if (!target) {
      const header = parseHeader(stderr);
      if (header) {
        target = header;
        send('header', { target, host: opts.host, options: opts });
      }
    }
  });

  child.on('error', (err) => finish('failed', { error: `Failed to run ${TRACEROUTE_BIN}: ${err.message}` }));

  child.on('close', (code) => {
    if (buffer.trim()) onLine(buffer);
    if (!target) {
      const header = parseHeader(stderr);
      if (header) target = header;
    }
    if (!hops.length && stderr.trim()) {
      return finish('failed', { error: stderr.trim().split('\n')[0] });
    }
    finish('done', summarize({ host: opts.host, target }, hops, {
      options: opts,
      exitCode: code,
      durationMs: Date.now() - started,
      command: `${TRACEROUTE_BIN} ${buildArgs(opts).join(' ')}`,
    }));
  });

  req.on('close', () => {
    closed = true;
    if (!child.killed) child.kill('SIGTERM');
  });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, traceroute: TRACEROUTE_BIN, platform: process.platform });
  }

  if (url.pathname === '/api/trace' || url.pathname === '/api/trace/stream') {
    const opts = validateQuery(url.searchParams);
    if (opts.error) return sendJson(res, 400, { error: opts.error });
    return url.pathname.endsWith('/stream')
      ? handleTraceStream(req, res, opts)
      : handleTrace(req, res, opts);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  serveStatic(req, res, url.pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Retry with: PORT=4181 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, BIND, () => {
  console.log(`traceroute-visualizer -> http://${BIND}:${PORT}`);
  console.log(`using binary: ${TRACEROUTE_BIN}`);
});
