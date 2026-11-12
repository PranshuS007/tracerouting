'use strict';

/**
 * Animated routing-topology background.
 *
 * Drifting router nodes, proximity links, and "packets" that trace multi-hop
 * paths across the mesh. Purely decorative: pointer-events none, DPR aware,
 * paused when the tab is hidden, static when prefers-reduced-motion is set.
 */

(function initRouteBackground() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LINK_RADIUS = 168;
  const MAX_PACKETS = 9;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let nodes = [];
  let packets = [];
  let lastSpawn = 0;
  let rafId = null;

  const rand = (min, max) => min + Math.random() * (max - min);

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    const count = Math.round(Math.min(72, Math.max(18, (width * height) / 26000)));
    nodes = Array.from({ length: count }, () => ({
      x: rand(0, width),
      y: rand(0, height),
      vx: rand(-9, 9),
      vy: rand(-9, 9),
      r: rand(1.1, 2.6),
      pulse: rand(0, Math.PI * 2),
      hub: Math.random() < 0.14,
    }));
    packets = [];
  }

  function neighbours(node, limit = 5) {
    const found = [];
    for (const other of nodes) {
      if (other === node) continue;
      const dx = other.x - node.x;
      const dy = other.y - node.y;
      const dist = Math.hypot(dx, dy);
      if (dist < LINK_RADIUS) found.push({ node: other, dist });
    }
    found.sort((a, b) => a.dist - b.dist);
    return found.slice(0, limit).map((entry) => entry.node);
  }

  function spawnPacket() {
    if (packets.length >= MAX_PACKETS) return;
    const start = nodes[Math.floor(Math.random() * nodes.length)];
    if (!start) return;

    const path = [start];
    const hops = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < hops; i += 1) {
      const options = neighbours(path[path.length - 1], 4).filter((n) => !path.includes(n));
      if (!options.length) break;
      path.push(options[Math.floor(Math.random() * options.length)]);
    }
    if (path.length < 2) return;

    packets.push({
      path,
      segment: 0,
      t: 0,
      speed: rand(0.55, 1.05),
      hue: Math.random() < 0.35 ? 'violet' : 'cyan',
      trail: [],
    });
  }

  function drawLinks() {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > LINK_RADIUS) continue;
        const alpha = (1 - dist / LINK_RADIUS) * 0.16;
        ctx.strokeStyle = `rgba(96, 148, 190, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  function drawNodes(now) {
    for (const node of nodes) {
      const glow = 0.35 + 0.25 * Math.sin(now / 1400 + node.pulse);
      if (node.hub) {
        const halo = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, 26);
        halo.addColorStop(0, `rgba(34, 211, 238, ${(0.16 * glow).toFixed(3)})`);
        halo.addColorStop(1, 'rgba(34, 211, 238, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 26, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = node.hub
        ? `rgba(125, 235, 255, ${(0.55 + glow * 0.4).toFixed(3)})`
        : `rgba(150, 178, 208, ${(0.22 + glow * 0.35).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPackets(dt) {
    for (let i = packets.length - 1; i >= 0; i -= 1) {
      const packet = packets[i];
      const from = packet.path[packet.segment];
      const to = packet.path[packet.segment + 1];
      if (!from || !to) {
        packets.splice(i, 1);
        continue;
      }

      const dist = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      packet.t += (packet.speed * dt * 120) / dist;

      while (packet.t >= 1) {
        packet.t -= 1;
        packet.segment += 1;
        if (packet.segment >= packet.path.length - 1) break;
      }

      if (packet.segment >= packet.path.length - 1) {
        packets.splice(i, 1);
        continue;
      }

      const a = packet.path[packet.segment];
      const b = packet.path[packet.segment + 1];
      const px = a.x + (b.x - a.x) * packet.t;
      const py = a.y + (b.y - a.y) * packet.t;
      const colour = packet.hue === 'violet' ? '167, 139, 250' : '34, 211, 238';

      packet.trail.push([px, py]);
      if (packet.trail.length > 18) packet.trail.shift();

      // trail
      for (let k = 0; k < packet.trail.length; k += 1) {
        const [tx, ty] = packet.trail[k];
        const fade = (k / packet.trail.length) * 0.5;
        ctx.fillStyle = `rgba(${colour}, ${fade.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(tx, ty, 1.3 * (k / packet.trail.length) + 0.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // head glow
      const halo = ctx.createRadialGradient(px, py, 0, px, py, 14);
      halo.addColorStop(0, `rgba(${colour}, .55)`);
      halo.addColorStop(1, `rgba(${colour}, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(px, py, 14, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(${colour}, .95)`;
      ctx.beginPath();
      ctx.arc(px, py, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function step(dt, now) {
    for (const node of nodes) {
      node.x += node.vx * dt;
      node.y += node.vy * dt;
      if (node.x < -20) node.x = width + 20;
      if (node.x > width + 20) node.x = -20;
      if (node.y < -20) node.y = height + 20;
      if (node.y > height + 20) node.y = -20;
    }
    if (now - lastSpawn > 780) {
      lastSpawn = now;
      spawnPacket();
    }
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
    frame.last = now;

    ctx.clearRect(0, 0, width, height);
    step(dt, now);
    drawLinks();
    drawNodes(now);
    drawPackets(dt);

    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (rafId != null) return;
    frame.last = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId == null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  function renderOnce() {
    ctx.clearRect(0, 0, width, height);
    drawLinks();
    drawNodes(0);
    for (let i = 0; i < 6; i += 1) {
      spawnPacket();
      const packet = packets[i];
      if (!packet) continue;
      const a = packet.path[0];
      const b = packet.path[1];
      packet.t = (i + 1) / 7;
      const px = a.x + (b.x - a.x) * packet.t;
      const py = a.y + (b.y - a.y) * packet.t;
      const colour = packet.hue === 'violet' ? '167, 139, 250' : '34, 211, 238';
      ctx.fillStyle = `rgba(${colour}, .8)`;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    packets = [];
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      if (reduced) renderOnce();
    }, 150);
  });

  document.addEventListener('visibilitychange', () => {
    if (reduced) return;
    if (document.hidden) stop();
    else start();
  });

  resize();
  if (reduced) renderOnce();
  else start();
})();
