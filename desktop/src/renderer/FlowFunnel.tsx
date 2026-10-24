import { useEffect, useRef, useState } from 'react';
import { describeHover, FLOW_STAGE_X, FLOW_STEP, layoutFlow, type FlowLayout, type FlowStage, type FlowStrand } from './flow-funnel';
import './FlowFunnel.css';

// 通用流图：线条和光点全部由调用方给的真实数据驱动。
// 新出现一条内容、或者一条内容有了去向，就沿它的线流过一个光点；没有新事件时画面静止。
type Rgb = [number, number, number];
type Engine = { setStrands(next: FlowStrand[]): void; setFocus(index: number | null): void; setOutput(label: string, note: string): void; setAmbient(on: boolean): void; destroy(): void };

function createEngine(host: HTMLDivElement, canvas: HTMLCanvasElement, tip: HTMLDivElement): Engine {
  const ctx = canvas.getContext('2d')!, base = document.createElement('canvas'), bctx = base.getContext('2d')!;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = getComputedStyle(host);
  const color = (name: string, fallback: Rgb) => { const v = css.getPropertyValue(name).trim().split(',').map(Number); return (v.length === 3 && v.every(Number.isFinite) ? v : fallback) as Rgb; };
  const C = { ink: color('--flow-ink', [31, 41, 55]), accent: color('--flow-accent', [230, 0, 0]), line: color('--flow-line', [226, 212, 214]), bg: color('--flow-bg', [255, 255, 255]), surface: color('--flow-surface', [255, 255, 255]) };
  const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  let strands: FlowStrand[] = [], L: FlowLayout | null = null, index = new Map<string, number>(), dpr = 1;
  let pulses: { id: string; x: number; v: number }[] = [], pending: string[] = [], acc = 0, last = 0;
  let introAt = -1e9, glowAt = -1e9, hover: { line: number | null; bundle: number | null } | null = null, focus: number | null = null;
  let output = { label: '', note: '' }, raf = 0, visible = true, alive = true, ambient = false;
  const INTRO = 1200;

  function trace(c: CanvasRenderingContext2D, ys: Float32Array, a: number, b: number) {
    const i0 = Math.max(0, Math.floor(a / FLOW_STEP)), i1 = Math.min(ys.length - 1, Math.ceil(b / FLOW_STEP));
    c.beginPath(); c.moveTo(Math.max(a, 0), ys[i0]);
    for (let i = i0 + 1; i <= i1; i += 1) c.lineTo(Math.min(i * FLOW_STEP, b), ys[i]);
  }
  function drawIcon(c: CanvasRenderingContext2D, glow: number) {
    if (!L) return;
    const p = L.icon;
    c.save();
    if (glow > 0) { c.shadowColor = rgba(C.accent, 0.5 * glow); c.shadowBlur = 18 * glow; }
    c.beginPath(); if (c.roundRect) c.roundRect(p.x, p.y, p.w, p.h, 5); else c.rect(p.x, p.y, p.w, p.h);
    c.fillStyle = rgba(C.surface, 1); c.fill(); c.shadowBlur = 0;
    c.lineWidth = 1; c.strokeStyle = glow > 0 ? rgba(C.accent, 0.35 + 0.65 * glow) : rgba(C.line, 1); c.stroke();
    c.restore();
    const x = p.x + p.w * 0.2, w = p.w * 0.6;
    for (let i = 0; i < 4; i += 1) {
      const y = p.y + p.h * (0.2 + i * 0.19);
      c.fillStyle = i === 0 ? rgba(C.accent, 1) : rgba(C.ink, 0.3);
      c.beginPath(); c.arc(x + 2, y + 1.5, 2, 0, Math.PI * 2); c.fill();
      c.fillRect(x + 7, y + 0.5, (w - 7) * (i === 0 ? 1 : 0.75), 2);
    }
  }
  function drawBase() {
    const c = bctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, host.clientWidth, host.clientHeight);
    if (!L) return;
    const a = L.lines.length > 120 ? 0.09 : 0.13;
    c.lineWidth = 1; c.lineJoin = 'round';
    for (const l of L.lines) {
      const b = L.bundles[l.bundle];
      trace(c, l.ys, 0, Math.min(l.end, L.gate)); c.strokeStyle = rgba(C.ink, a); c.stroke();
      if (!b) continue;
      trace(c, l.ys, L.gate, l.end);
      if (b.pass) c.strokeStyle = rgba(C.accent, 0.4);
      else { const g = c.createLinearGradient(L.gate, 0, l.end, 0); g.addColorStop(0, rgba(C.ink, a)); g.addColorStop(1, rgba(C.ink, 0)); c.strokeStyle = g; }
      c.stroke();
    }
    // 闸门：判定前是一条淡线；判定后只在通过的几束处留口。
    c.lineWidth = 1; c.strokeStyle = rgba(C.line, L.decided ? 1 : 0.6); c.beginPath();
    const holes = L.bundles.filter((b) => b.pass).map((b) => [b.y - b.half - 7, b.y + b.half + 7]);
    let y = L.h * 0.05;
    for (const [t, bottom] of holes) { c.moveTo(L.gate, y); c.lineTo(L.gate, t); y = bottom; }
    c.moveTo(L.gate, y); c.lineTo(L.gate, L.h * 0.95); c.stroke();
    for (const [t, bottom] of holes) for (const yy of [t, bottom]) { c.beginPath(); c.moveTo(L.gate - 4, yy); c.lineTo(L.gate + 4, yy); c.stroke(); }
    if (holes.length) { c.beginPath(); c.moveTo(L.xo, L.outY); c.lineTo(L.icon.x, L.outY); c.lineWidth = 1.6; c.strokeStyle = rgba(C.accent, 0.95); c.stroke(); }
    drawIcon(c, 0);
    c.save(); c.globalCompositeOperation = 'destination-out';
    const fw = Math.min(64, L.w * 0.06), g = c.createLinearGradient(0, 0, fw, 0);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, 0, fw, L.h); c.restore();
  }
  function relayout() {
    const w = host.clientWidth, h = host.clientHeight;
    if (w < 10 || h < 10) { L = null; return; }
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [canvas, base]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    L = strands.length ? layoutFlow(strands, w, h) : null;
    index = new Map(L ? L.lines.map((l, i) => [l.strand.id, i]) : []);
    drawBase();
  }

  function frame(now: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!L) return;
    const intro = reduce ? 1 : Math.min(1, (now - introAt) / INTRO);
    if (intro < 1) {
      const x = (L.w + 80) * ((1 - Math.cos(Math.PI * intro)) / 2);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, Math.max(0, x) * dpr, canvas.height); ctx.clip(); ctx.drawImage(base, 0, 0); ctx.restore();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = ctx.createLinearGradient(x - 80, 0, x, 0); g.addColorStop(0, rgba(C.bg, 0)); g.addColorStop(1, rgba(C.bg, 1));
      ctx.fillStyle = g; ctx.fillRect(x - 80, 0, 80, L.h);
      return;
    }
    ctx.drawImage(base, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (hover) {
      const set = hover.line !== null ? [L.lines[hover.line]] : L.lines.filter((l) => l.bundle === hover!.bundle);
      ctx.lineWidth = set.length > 1 ? 1 : 1.5;
      for (const l of set) {
        const pass = L.bundles[l.bundle]?.pass;
        trace(ctx, l.ys, 0, Math.min(l.end, L.gate)); ctx.strokeStyle = rgba(C.ink, set.length > 1 ? 0.45 : 0.9); ctx.stroke();
        if (l.end > L.gate) { trace(ctx, l.ys, L.gate, l.end); ctx.strokeStyle = pass ? rgba(C.accent, 0.95) : rgba(C.ink, set.length > 1 ? 0.3 : 0.6); ctx.stroke(); }
      }
    }
    const tail = Math.max(24, Math.min(56, L.w * 0.04));
    ctx.lineWidth = 1.8;
    for (const p of pulses) {
      const i = index.get(p.id);
      if (i === undefined) continue;
      const l = L.lines[i], x = Math.min(p.x, l.end), pass = L.bundles[l.bundle]?.pass;
      if (x <= 0) continue;
      let col = C.ink, a = 0.7;
      if (x >= L.gate) { if (pass) { col = C.accent; a = 1; } else a *= Math.max(0, 1 - (x - L.gate) / (l.end - L.gate)); }
      if (a <= 0.01) continue;
      const a0 = Math.max(0, x - tail), g = ctx.createLinearGradient(a0, 0, x, 0);
      g.addColorStop(0, rgba(col, 0)); g.addColorStop(1, rgba(col, a));
      trace(ctx, l.ys, a0, x); ctx.strokeStyle = g; ctx.stroke();
    }
    const gl = (now - glowAt) / 900;
    if (gl >= 0 && gl < 1) drawIcon(ctx, 1 - gl);
    if (focus !== null) {
      ctx.fillStyle = rgba(C.bg, 0.62);
      for (let i = 0; i < 4; i += 1) if (i !== focus) ctx.fillRect(L.w * FLOW_STAGE_X[i], 0, L.w * (FLOW_STAGE_X[i + 1] - FLOW_STAGE_X[i]), L.h);
    }
  }
  const busy = (now: number) => ambient || pulses.length > 0 || pending.length > 0 || now - introAt < INTRO || now - glowAt < 900;
  function tick(now: number) {
    raf = 0;
    if (!L || !alive) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0); last = now;
    if (now - introAt >= INTRO * 0.8) {
      // 一次来很多条（比如扒完统一判定）时加快放行，几秒内流完。
      const rate = Math.max(8, pending.length / 2.5);
      for (acc += dt * rate; acc >= 1 && pending.length && pulses.length < 90; acc -= 1) pulses.push({ id: pending.shift()!, x: -Math.random() * 30, v: L.w * (0.26 + Math.random() * 0.08) });
      // 常驻流动：没有新事件时，也沿真实的线持续流过光点（偶尔走通过的线），画面一直是活的。
      if (ambient && !pending.length && L.lines.length) {
        const passing = L.lines.flatMap((l, i) => L!.bundles[l.bundle]?.pass ? [i] : []);
        for (acc += dt * (L.w >= 900 ? 6 : 4); acc >= 1 && pulses.length < 60; acc -= 1) {
          const i = passing.length && Math.random() < 0.15 ? passing[Math.floor(Math.random() * passing.length)] : Math.floor(Math.random() * L.lines.length);
          pulses.push({ id: L.lines[i].strand.id, x: -Math.random() * 30, v: L.w * (0.12 + Math.random() * 0.06) });
        }
      } else if (!pending.length) acc = 0;
      const keep = [];
      for (const p of pulses) {
        const i = index.get(p.id);
        if (i === undefined) continue;
        p.x += p.v * dt;
        const l = L.lines[i];
        if (p.x < l.end) keep.push(p); else if (L.bundles[l.bundle]?.pass) glowAt = now;
      }
      pulses = keep;
    }
    frame(now);
    if (busy(now)) schedule(); else last = 0;
  }
  function schedule() { if (!raf && alive && !reduce && visible && !document.hidden && L) raf = requestAnimationFrame(tick); }
  const redraw = () => frame(performance.now());

  function showTip(x: number, y: number, title: string, detail: string) {
    (tip.querySelector('b') as HTMLElement).textContent = title; (tip.querySelector('span') as HTMLElement).textContent = detail; tip.hidden = false;
    const left = Math.min(Math.max(8, x + 14), host.clientWidth - tip.offsetWidth - 8);
    const top = y + 16 + tip.offsetHeight > host.clientHeight ? Math.max(8, y - tip.offsetHeight - 10) : y + 16;
    tip.style.transform = `translate(${left}px,${top}px)`;
  }
  function onMove(event: PointerEvent) {
    if (!L) return;
    const rect = host.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top, p = L.icon;
    if (L.decided && output.label && x >= p.x - 8 && x <= p.x + p.w + 8 && y >= p.y - 8 && y <= p.y + p.h + 8) { hover = null; showTip(x, y, output.label, output.note); redraw(); return; }
    const col = Math.round(x / FLOW_STEP);
    let best = -1, distance = 7;
    L.lines.forEach((l, i) => { if (x > l.end + 2) return; const d = Math.abs(l.ys[Math.min(col, l.ys.length - 1)] - y); if (d < distance) { distance = d; best = i; } });
    if (best < 0) { hover = null; tip.hidden = true; redraw(); return; }
    const line = L.lines[best], whole = line.bundle >= 0 && x >= L.x2;
    hover = whole ? { line: null, bundle: line.bundle } : { line: best, bundle: null };
    const text = describeHover(L, best, x);
    showTip(x, y, text.title, text.detail);
    redraw();
  }
  function onLeave() { hover = null; tip.hidden = true; redraw(); }
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);
  const resizer = new ResizeObserver(() => { relayout(); redraw(); schedule(); });
  resizer.observe(host);
  const watcher = new IntersectionObserver(([entry]) => { visible = Boolean(entry?.isIntersecting); last = 0; schedule(); });
  watcher.observe(host);
  const onVisibility = () => { last = 0; schedule(); };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    setStrands(next) {
      const before = new Map(strands.map((s) => [s.id, s]));
      const wasDecided = Boolean(L?.decided), hadLines = Boolean(L);
      strands = next;
      relayout();
      if (!L) { pulses = []; pending = []; tip.hidden = true; hover = null; redraw(); return; }
      // 第一次有数据、或者从「扒取中」变成「已判定」时，整张图从左往右展开一次。
      if (!hadLines || L.decided !== wasDecided) { introAt = performance.now(); hover = null; tip.hidden = true; }
      const queued = new Set(pending);
      for (const s of next) {
        const old = before.get(s.id);
        if ((!old || old.outcome !== s.outcome) && !queued.has(s.id)) { pending.push(s.id); queued.add(s.id); }
      }
      redraw(); schedule();
    },
    setFocus(value) { focus = value; redraw(); },
    setOutput(label, note) { output = { label, note }; },
    setAmbient(on) { ambient = on && !reduce; schedule(); },
    destroy() {
      alive = false; if (raf) cancelAnimationFrame(raf);
      host.removeEventListener('pointermove', onMove); host.removeEventListener('pointerleave', onLeave);
      resizer.disconnect(); watcher.disconnect(); document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

export function FlowFunnel({ strands, stages, live, outputLabel = '', outputNote = '', emptyText, height = 240, ambient = false, summary }: {
  strands: FlowStrand[]; stages: FlowStage[]; live?: string; outputLabel?: string; outputNote?: string; emptyText: string; height?: number;
  ambient?: boolean; summary?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), tipRef = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => {
    if (!hostRef.current || !canvasRef.current || !tipRef.current) return;
    const created = createEngine(hostRef.current, canvasRef.current, tipRef.current);
    engine.current = created;
    return () => { created.destroy(); engine.current = null; };
  }, []);
  useEffect(() => { engine.current?.setOutput(outputLabel, outputNote); }, [outputLabel, outputNote]);
  useEffect(() => { engine.current?.setStrands(strands); }, [strands]);
  useEffect(() => { engine.current?.setFocus(focus); }, [focus]);
  useEffect(() => { engine.current?.setAmbient(ambient); }, [ambient]);
  return (
    <div className="flow-funnel">
      <div className="flow-funnel-canvas" ref={hostRef} style={{ height }}>
        <canvas ref={canvasRef} aria-hidden="true" />
        <div className="flow-funnel-tip" ref={tipRef} hidden><b /><span /></div>
        {!strands.length && <p className="flow-funnel-empty">{emptyText}</p>}
        {live && <span className="flow-funnel-live"><i />{live}</span>}
      </div>
      {summary ? <div className="flow-funnel-summary">{stages.map((stage, i) => <span key={stage.no} className={stage.accent ? 'accent' : ''}>
        {i > 0 && <i aria-hidden="true">→</i>}{stage.label}<b>{stage.value === null ? '—' : stage.value.toLocaleString('zh-CN')}</b>{stage.unit}</span>)}</div> :
      <div className={`flow-funnel-stages${focus !== null ? ' focusing' : ''}`}>
        {stages.map((stage, i) => (
          <div key={stage.no} className={`flow-funnel-stage${focus === i ? ' on' : ''}`} onPointerEnter={() => setFocus(i)} onPointerLeave={() => setFocus(null)}>
            <div className="flow-funnel-no">{stage.no} {stage.label}</div>
            <span className={`flow-funnel-n${stage.accent ? ' accent' : ''}`}>{stage.value === null ? '—' : stage.value.toLocaleString('zh-CN')}</span> <span className="flow-funnel-u">{stage.unit}</span>
            {stage.note && <div className="flow-funnel-d">{stage.note}</div>}
          </div>
        ))}
      </div>}
    </div>
  );
}
