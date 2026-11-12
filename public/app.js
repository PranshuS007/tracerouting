'use strict';

/* ============================================================ state & utils */

const HISTORY_KEY = 'routesco.pe.history.v1';
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  host: '',
  target: null,
  hops: [],
  stats: null,
  meta: null,
  selected: null,
  running: false,
  source: 'live',
  rendered: 0,
};

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const fmt = (n, digits = 1) =>
  n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)} ms`;

function toast(message, isError = false) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.toggle('error', isError);
  box.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => box.classList.remove('show'), 3200);
}

/* ---------------------------------------------------------- ip scope logic */

function scopeOf(ip) {
  if (!ip) return 'unknown';
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    if (low === '::1') return 'loopback';
    if (low.startsWith('fe80')) return 'linklocal';
    if (low.startsWith('ff')) return 'multicast';
    if (low.startsWith('fc') || low.startsWith('fd')) return 'private';
    return 'public';
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return 'unknown';
  }
  const [a, b] = parts;
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 169 && b === 254) return 'linklocal';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a === 0 || a >= 240) return 'reserved';
  return 'public';
}

const SCOPE_LABEL = {
  public: 'public',
  private: 'private',
  cgnat: 'cgnat',
  loopback: 'loopback',
  linklocal: 'link-local',
  multicast: 'multicast',
  reserved: 'reserved',
  unknown: 'timeout',
};

function tierOf(rtt) {
  if (rtt == null) return 'dead';
  if (rtt <= 30) return 'fast';
  if (rtt <= 100) return 'mid';
  return 'slow';
}

const TIER_CLASS = { fast: '', mid: 'tier-mid', slow: 'tier-slow', dead: 'tier-dead' };

/* ================================================================== parsing */

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,}$/;

function looksLikeIp(token) {
  if (IPV4_RE.test(token)) return true;
  return IPV6_RE.test(token) && token.includes(':');
}

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
  return {
    hop,
    ip: probes.find((p) => p.ip)?.ip || null,
    probes,
    responded: rtts.length > 0,
    min: rtts.length ? Math.min(...rtts) : null,
    max: rtts.length ? Math.max(...rtts) : null,
    avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
  };
}

function parseRawOutput(text) {
  const hops = [];
  let target = null;
  for (const line of text.split('\n')) {
    if (!target) {
      const m = /traceroute to (\S+)(?: \(([^)]+)\))?/.exec(line);
      if (m) target = { name: m[1], ip: m[2] || (looksLikeIp(m[1]) ? m[1] : null) };
    }
    const hop = parseHopLine(line);
    if (hop) hops.push(hop);
  }
  return { hops, target };
}

function computeStats(host, target, hops) {
  const responded = hops.filter((h) => h.responded);
  const rtts = responded.flatMap((h) => h.probes.filter((p) => p.rtt !== null).map((p) => p.rtt));
  return {
    host,
    target,
    stats: {
      hopCount: hops.length,
      respondedHops: responded.length,
      timeouts: hops.length - responded.length,
      min: rtts.length ? Math.min(...rtts) : null,
      max: rtts.length ? Math.max(...rtts) : null,
      avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
      reached: Boolean(target?.ip) && hops.some((h) => h.ip === target.ip),
    },
    meta: null,
  };
}

/* ==================================================================== render */

function applyResult(payload, { source = 'live', appendHistory = true, animateFrom = 0 } = {}) {
  state.host = payload.host;
  state.target = payload.target || null;
  state.hops = payload.hops || [];
  state.stats = payload.stats || null;
  state.meta = { options: payload.options, durationMs: payload.durationMs, exitCode: payload.exitCode, command: payload.command };
  state.source = source;
  state.selected = state.hops.length ? state.hops[0].hop : null;

  renderRail(animateFrom);
  renderChart();
  renderTable();
  renderStats();
  renderInspector();
  if (payload.command) $('#cmdLine').textContent = payload.command;

  if (appendHistory && state.hops.length) pushHistory(payload);
}

function clearAll() {
  state.host = '';
  state.target = null;
  state.hops = [];
  state.stats = null;
  state.meta = null;
  state.selected = null;
  state.rendered = 0;
  renderRail(0);
  renderChart();
  renderTable();
  renderStats();
  renderInspector();
  $('#cmdLine').textContent = '—';
}

function setRunning(running) {
  state.running = running;
  $('#runBtn').disabled = running;
  $('#stopBtn').disabled = !running;
}

function renderRail(animateFrom = 0) {
  const rail = $('#rail');
  rail.textContent = '';

  if (!state.hops.length) {
    rail.appendChild(
      el('div', 'empty', state.running ? 'Tracing… waiting for first hop' : 'No trace yet — run one to see the hop-by-hop path.')
    );
    return;
  }

  state.hops.forEach((hop, i) => {
    if (i > 0) {
      const prev = state.hops[i - 1];
      const edge = el('div', `hop-edge${!prev.responded || !hop.responded ? ' dead' : ''}`);
      if (!state.running) edge.classList.add('done');
      rail.appendChild(edge);
    }

    const tier = tierOf(hop.avg);
    const btn = el('button', `hop-node${hop.hop === state.selected ? ' selected' : ''}`);
    btn.type = 'button';
    btn.dataset.hop = String(hop.hop);
    btn.title = hop.ip ? `${hop.ip} — ${fmt(hop.avg)}` : 'no response';
    if (i >= animateFrom) btn.style.animation = 'hopIn .34s ease both';
    else btn.style.animation = 'none';

    const node = el('div', `node ${TIER_CLASS[tier]}`.trim(), String(hop.hop));
    btn.appendChild(node);

    const meta = el('div', 'node-meta');
    meta.appendChild(el('span', 'node-ip', hop.ip || 'no response'));
    meta.appendChild(el('span', 'node-rtt', hop.responded ? fmt(hop.avg) : 'timeout'));
    btn.appendChild(meta);

    btn.addEventListener('click', () => selectHop(hop.hop));
    rail.appendChild(btn);
  });
}

function renderChart() {
  const chart = $('#chart');
  const box = chart.parentElement;
  chart.textContent = '';

  const hops = state.hops;
  const empty = $('#chartEmpty');
  if (!hops.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const width = Math.max(320, box.clientWidth - 8);
  const height = 200;
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const pad = { l: 48, r: 14, t: 16, b: 26 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const maxRtt = Math.max(1, ...hops.map((h) => h.max ?? 0));
  const top = maxRtt * 1.1;
  const y = (v) => pad.t + innerH - (v / top) * innerH;

  for (let i = 0; i <= 4; i++) {
    const value = (top / 4) * i;
    const yPos = y(value);
    chart.appendChild(svg('line', { x1: pad.l, x2: width - pad.r, y1: yPos, y2: yPos, class: 'grid-line' }));
    const label = svg('text', { x: pad.l - 8, y: yPos + 3.5, 'text-anchor': 'end', class: 'axis-label' });
    label.textContent = `${value.toFixed(value < 10 ? 1 : 0)}ms`;
    chart.appendChild(label);
  }

  const slot = innerW / hops.length;
  const barW = Math.max(3, Math.min(30, slot * 0.52));
  const baseline = pad.t + innerH;

  hops.forEach((hop, i) => {
    const cx = pad.l + slot * (i + 0.5);
    const tier = tierOf(hop.avg);

    if (hop.responded) {
      const barH = Math.max(2, baseline - y(hop.avg));
      const bar = svg('rect', {
        x: cx - barW / 2,
        y: baseline - barH,
        width: barW,
        height: barH,
        rx: Math.min(4, barW / 2),
        class: 'bar',
        fill: tier === 'slow' ? 'rgba(248,113,113,.85)' : tier === 'mid' ? 'rgba(251,191,36,.85)' : 'rgba(52,211,153,.85)',
      });
      const tip = svg('title');
      tip.textContent = `hop ${hop.hop} · ${hop.ip || 'no ip'} · min ${fmt(hop.min)} / avg ${fmt(hop.avg)} / max ${fmt(hop.max)}`;
      bar.appendChild(tip);
      chart.appendChild(bar);

      if (hop.min !== hop.max) {
        chart.appendChild(svg('line', {
          x1: cx, x2: cx, y1: y(hop.min), y2: y(hop.max),
          stroke: 'rgba(230,237,247,.45)', 'stroke-width': 1.4,
        }));
        chart.appendChild(svg('line', { x1: cx - 4, x2: cx + 4, y1: y(hop.max), y2: y(hop.max), stroke: 'rgba(230,237,247,.45)', 'stroke-width': 1.4 }));
      }
    } else {
      chart.appendChild(svg('line', {
        x1: cx, x2: cx, y1: baseline - 10, y2: baseline,
        stroke: 'rgba(82,97,120,.9)', 'stroke-width': 2, 'stroke-dasharray': '3 3',
      }));
    }

    if (hops.length <= 18 || i % Math.ceil(hops.length / 18) === 0) {
      const label = svg('text', { x: cx, y: height - 8, 'text-anchor': 'middle', class: 'axis-label' });
      label.textContent = String(hop.hop);
      chart.appendChild(label);
    }
  });

  // contiguous profile line across responded hops
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      chart.appendChild(svg('polyline', {
        class: 'profile-line',
        points: run.map(([x, yy]) => `${x},${yy}`).join(' '),
      }));
    }
    run.forEach(([x, yy]) => chart.appendChild(svg('circle', { cx: x, cy: yy, r: 3.1, class: 'profile-dot' })));
    run = [];
  };
  hops.forEach((hop, i) => {
    if (hop.responded) run.push([pad.l + slot * (i + 0.5), y(hop.avg)]);
    else flush();
  });
  flush();
}

function renderTable() {
  const body = $('#hopsBody');
  body.textContent = '';
  $('#hopsSub').textContent = state.hops.length ? `${state.hops.length} hops` : '—';

  if (!state.hops.length) {
    const tr = el('tr', 'empty-row');
    const td = el('td', null, 'Hop table is empty.');
    td.colSpan = 7;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const hop of state.hops) {
    const tier = tierOf(hop.avg);
    const tr = el('tr', hop.hop === state.selected ? 'selected' : '');
    tr.dataset.hop = String(hop.hop);

    const tdNum = el('td');
    tdNum.appendChild(el('span', `hop-badge ${TIER_CLASS[tier]}`.trim(), String(hop.hop)));
    tr.appendChild(tdNum);

    const tdIp = el('td');
    tdIp.appendChild(el('span', `ip${hop.ip ? '' : ' dim'}`, hop.ip || '* * *'));
    tr.appendChild(tdIp);

    const tdScope = el('td');
    const scope = scopeOf(hop.ip);
    tdScope.appendChild(el('span', `tag ${scope}`, SCOPE_LABEL[scope]));
    tr.appendChild(tdScope);

    tr.appendChild(sparkCell(hop));

    for (const key of ['min', 'avg', 'max']) {
      tr.appendChild(el('td', 'num', hop.responded ? fmt(hop[key]) : '—'));
    }

    tr.addEventListener('click', () => selectHop(hop.hop));
    body.appendChild(tr);
  }
}

function sparkCell(hop) {
  const td = el('td');
  const wrap = el('div', 'spark');
  const rtts = hop.probes.map((p) => p.rtt);
  const max = Math.max(1, ...rtts.filter((v) => v != null));
  for (const rtt of rtts) {
    if (rtt == null) {
      wrap.appendChild(el('i', 'miss'));
      continue;
    }
    const bar = el('i', rtt > 100 ? 'hot' : rtt > 30 ? 'warm' : '');
    bar.style.height = `${Math.max(14, (rtt / max) * 100)}%`;
    bar.style.flex = '0 0 6px';
    bar.title = fmt(rtt);
    wrap.appendChild(bar);
  }
  td.appendChild(wrap);
  return td;
}

function renderStats() {
  const s = state.stats;
  const set = (id, value, cls) => {
    const node = $(id);
    node.textContent = value;
    node.className = `v mono${cls ? ` ${cls}` : ''}`;
  };

  set('#statTarget', state.target?.ip || state.target?.name || state.host || '—');
  set('#statHops', s ? String(s.hopCount) : '0');
  set('#statResponded', s ? String(s.respondedHops) : '0');
  set('#statTimeouts', s ? String(s.timeouts) : '0', s && s.timeouts > 0 ? 'warn' : '');
  set('#statMin', s ? fmt(s.min) : '—');
  set('#statAvg', s ? fmt(s.avg) : '—');
  set('#statMax', s ? fmt(s.max) : '—', s && s.max > 150 ? 'bad' : s && s.max > 60 ? 'warn' : '');
  set('#statReached', s ? (s.reached ? 'yes' : 'no') : '—', s ? (s.reached ? 'good' : 'warn') : '');

  $('#statDuration').textContent = state.meta?.durationMs != null
    ? `${(state.meta.durationMs / 1000).toFixed(2)}s · ${state.source === 'live' ? 'live' : state.source}`
    : '—';
}

function renderInspector() {
  const box = $('#inspectorBody');
  box.textContent = '';
  const hop = state.hops.find((h) => h.hop === state.selected);
  if (!hop) {
    box.appendChild(el('p', 'muted', 'Select a hop in the path or table.'));
    return;
  }

  const tier = tierOf(hop.avg);
  const head = el('div', 'inspector-head');
  head.appendChild(el('div', `node ${TIER_CLASS[tier]}`.trim(), String(hop.hop)));
  const title = el('div', 'inspector-title');
  title.appendChild(el('strong', null, hop.ip || 'no response'));
  title.appendChild(el('span', null, `hop ${hop.hop} · ${SCOPE_LABEL[scopeOf(hop.ip)]}`));
  head.appendChild(title);
  box.appendChild(head);

  const maxRtt = Math.max(1, ...hop.probes.map((p) => p.rtt ?? 0));
  const list = el('div', 'probe-list');
  hop.probes.forEach((probe, i) => {
    const miss = probe.rtt == null;
    const row = el('div', `probe-row${miss ? ' miss' : ''}`);
    row.appendChild(el('span', null, `#${i + 1}`));
    const bar = el('div', 'probe-bar');
    const fill = el('span');
    fill.style.width = miss ? '0%' : `${Math.max(4, (probe.rtt / maxRtt) * 100)}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    const value = el('b', null, miss ? 'timeout' : fmt(probe.rtt));
    row.appendChild(value);
    list.appendChild(row);
  });
  box.appendChild(list);

  const kv = el('dl', 'kv');
  const add = (k, v) => {
    kv.appendChild(el('dt', null, k));
    kv.appendChild(el('dd', null, v));
  };
  add('min', fmt(hop.min));
  add('avg', fmt(hop.avg));
  add('max', fmt(hop.max));
  if (hop.responded) add('jitter', fmt(hop.max - hop.min));
  add('loss', `${hop.probes.filter((p) => p.rtt == null).length}/${hop.probes.length}`);
  box.appendChild(kv);
}

function selectHop(hopNumber) {
  state.selected = hopNumber;
  document.querySelectorAll('.hop-node').forEach((node) => {
    node.classList.toggle('selected', node.dataset.hop === String(hopNumber));
  });
  document.querySelectorAll('.hops-table tbody tr').forEach((row) => {
    row.classList.toggle('selected', row.dataset.hop === String(hopNumber));
  });
  renderInspector();
}

/* =================================================================== history */

function readHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pushHistory(payload) {
  const entries = readHistory().filter((e) => e.host !== payload.host);
  entries.unshift({
    host: payload.host,
    target: payload.target?.ip || payload.target?.name || null,
    hopCount: payload.stats?.hopCount ?? payload.hops.length,
    avg: payload.stats?.avg ?? null,
    at: Date.now(),
  });
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 8)));
  } catch { /* ignore quota errors */ }
  renderHistory();
}

function renderHistory() {
  const list = $('#historyList');
  list.textContent = '';
  const entries = readHistory();
  if (!entries.length) {
    list.appendChild(el('li', 'muted', 'Nothing yet.'));
    return;
  }
  for (const entry of entries) {
    const li = el('li');
    const btn = el('button', 'history-item');
    btn.type = 'button';

    const left = el('div');
    left.appendChild(el('div', 'h-host', entry.host));
    left.appendChild(el('div', 'h-meta', `${entry.hopCount} hops${entry.avg != null ? ` · avg ${entry.avg.toFixed(1)}ms` : ''}`));
    btn.appendChild(left);
    btn.appendChild(el('span', 'h-meta', new Date(entry.at).toLocaleTimeString()));

    btn.addEventListener('click', () => {
      $('#hostInput').value = entry.host;
      runTrace();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/* ==================================================================== tracing */

let abortHandle = null;

function stopTrace() {
  if (abortHandle) {
    abortHandle.abort();
    abortHandle = null;
  }
  setRunning(false);
}

function runTrace() {
  const host = $('#hostInput').value.trim();
  if (!host) return toast('Enter a host or IP first.', true);
  stopTrace();

  const params = new URLSearchParams({
    host,
    maxHops: $('#maxHops').value || '30',
    probes: $('#probes').value || '3',
    protocol: $('#protocol').value || 'udp',
  });

  state.host = host;
  state.hops = [];
  state.stats = null;
  state.target = null;
  state.selected = null;
  state.rendered = 0;
  setRunning(true);
  renderRail(0);
  renderChart();
  renderTable();
  renderStats();
  renderInspector();
  $('#hint').textContent = `tracing ${host}…`;

  const source = new EventSource(`/api/trace/stream?${params.toString()}`);
  let finished = false;

  abortHandle = {
    abort() {
      source.close();
      finished = true;
    },
  };

  source.addEventListener('header', (event) => {
    const data = JSON.parse(event.data);
    state.target = data.target || null;
    renderStats();
  });

  source.addEventListener('hop', (event) => {
    const hop = JSON.parse(event.data);
    state.hops.push(hop);
    if (state.selected == null) state.selected = hop.hop;
    renderRail(state.rendered);
    state.rendered = state.hops.length;
    renderChart();
    renderTable();
    renderInspector();
    $('#statHops').textContent = String(state.hops.length);
    $('#statResponded').textContent = String(state.hops.filter((h) => h.responded).length);
  });

  source.addEventListener('done', (event) => {
    finished = true;
    source.close();
    abortHandle = null;
    setRunning(false);
    const payload = JSON.parse(event.data);
    applyResult(payload, { source: 'live', animateFrom: state.hops.length });
    $('#hint').textContent = `traced ${payload.stats.hopCount} hops in ${(payload.durationMs / 1000).toFixed(2)}s`;
    toast(`Trace complete · ${payload.stats.hopCount} hops`);
  });

  source.addEventListener('failed', (event) => {
    finished = true;
    source.close();
    abortHandle = null;
    setRunning(false);
    const data = JSON.parse(event.data);
    toast(data.error || 'Trace failed.', true);
    $('#hint').textContent = data.error || 'trace failed';
  });

  source.onerror = () => {
    if (finished) return;
    source.close();
    abortHandle = null;
    setRunning(false);
    toast('Connection to the traceroute backend was lost.', true);
  };
}

/* ==================================================================== events */

$('#traceForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runTrace();
});

$('#stopBtn').addEventListener('click', () => {
  stopTrace();
  setRunning(false);
  $('#hint').textContent = 'trace stopped';
  renderRail(0);
});

$('#togglePaste').addEventListener('click', () => {
  const wrap = $('#pasteWrap');
  wrap.hidden = !wrap.hidden;
  if (!wrap.hidden) $('#pasteInput').focus();
});

$('#renderPasteBtn').addEventListener('click', () => {
  const text = $('#pasteInput').value;
  if (!text.trim()) return toast('Paste some traceroute output first.', true);
  const { hops, target } = parseRawOutput(text);
  if (!hops.length) return toast('No hop lines recognised in that text.', true);
  const host = $('#hostInput').value.trim() || target?.name || 'pasted';
  applyResult({ ...computeStats(host, target, hops), hops }, { source: 'pasted' });
  toast(`Parsed ${hops.length} hops from pasted output`);
});

$('#loadSample').addEventListener('click', () => {
  const sample = buildSample();
  $('#hostInput').value = sample.host;
  applyResult(sample, { source: 'sample' });
  toast('Loaded sample route (offline demo)');
});

$('#clearBtn').addEventListener('click', () => {
  stopTrace();
  clearAll();
  $('#hint').textContent = 'Runs traceroute on the host machine and streams hops live.';
});

$('#copyJson').addEventListener('click', async () => {
  if (!state.hops.length) return toast('Nothing to copy yet.', true);
  const payload = {
    host: state.host,
    target: state.target,
    options: state.meta?.options ?? null,
    stats: state.stats,
    hops: state.hops,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast('Trace JSON copied to clipboard');
  } catch {
    toast('Clipboard blocked by the browser.', true);
  }
});

$('#clearHistory').addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

window.addEventListener('resize', () => {
  if (state.hops.length) renderChart();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.running) {
    stopTrace();
    $('#hint').textContent = 'trace stopped';
  }
});

/* ==================================================================== sample */

function buildSample() {
  const raw = [
    [1, '192.168.1.1', [2.78, 3.1, 2.94]],
    [2, '10.24.0.1', [7.32, 8.0, 7.61]],
    [3, null, [null, null, null]],
    [4, '62.115.12.5', [12.4, 12.9, 12.1]],
    [5, '62.115.132.18', [18.7, 19.4, 18.2]],
    [6, '80.239.194.112', [27.5, 31.2, 28.0]],
    [7, '195.66.238.234', [41.3, 44.8, 42.1]],
    [8, '172.16.4.9', [52.0, null, 55.4]],
    [9, '1.1.1.1', [58.2, 57.6, 59.1]],
  ];
  const hops = raw.map(([hop, ip, rtts]) => {
    const probes = rtts.map((rtt) => ({ ip: rtt == null ? null : ip, rtt }));
    const values = rtts.filter((v) => v != null);
    return {
      hop,
      ip,
      probes,
      responded: values.length > 0,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    };
  });
  const target = { name: 'one.one.one.one', ip: '1.1.1.1' };
  return {
    ...computeStats('one.one.one.one', target, hops),
    hops,
    options: { probes: 3, maxHops: 30, protocol: 'udp' },
    durationMs: 12480,
    command: 'traceroute -n -q 3 -w 2 -m 30 one.one.one.one',
  };
}

/* ====================================================================== boot */

async function checkHealth() {
  const pill = $('#serverPill');
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    pill.classList.add('ok');
    pill.querySelector('span').textContent = `backend ${data.ok ? 'online' : 'offline'}`;
    pill.title = `${data.traceroute} · ${data.platform}`;
  } catch {
    pill.classList.add('bad');
    pill.querySelector('span').textContent = 'backend offline';
  }
}

function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString();
}

checkHealth();
tickClock();
setInterval(tickClock, 1000);
renderHistory();
renderRail(0);
renderChart();
renderStats();

// deep links: ?host=example.com&maxHops=20  |  ?demo=1
const bootParams = new URLSearchParams(location.search);
if (bootParams.get('demo') === '1') {
  const sample = buildSample();
  $('#hostInput').value = sample.host;
  applyResult(sample, { source: 'sample' });
} else if (bootParams.get('host')) {
  $('#hostInput').value = bootParams.get('host');
  if (bootParams.get('maxHops')) $('#maxHops').value = bootParams.get('maxHops');
  runTrace();
}
