<svelte:options runes={true} />

<!--
  Interactive HiDPI 3D scene artifact: drag to orbit 360°, adjust the primary
  spatial parameter (twist, bond length, speed, explode gap, amplitude), or
  pause auto-rotation. Monochrome-first ink with a single warm focal accent.
-->

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Scene3DArtifactPayload } from '$lib/types/chat';
  import VizHeading from './VizHeading.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Range from '$lib/components/ui/Range.svelte';

  interface Props {
    payload: Scene3DArtifactPayload;
  }

  let { payload }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement>();
  let param = $state(52);
  let autoRotate = $state(true);
  let rotY = 0.55;
  let rotX = 0.34;
  let dragging = false;
  let lastPointer: { x: number; y: number } | null = null;
  let rafId = 0;
  let time = 0;
  let width = 560;
  const height = 310;

  $effect(() => {
    param = typeof payload.paramValue === 'number' ? payload.paramValue : 52;
    autoRotate = payload.autoRotate !== false;
  });

  const DEFAULT_META: Record<Scene3DArtifactPayload['preset'], { label: string; takeaway: string }> = {
    dna: { label: 'Helix twist', takeaway: 'Two antiparallel strands linked by complementary base-pair rungs.' },
    molecule: { label: 'Bond length', takeaway: 'Symmetric 109.5° tetrahedral bond geometry in 3D space.' },
    orbit: { label: 'Orbital speed', takeaway: 'Inner bodies complete orbits faster along inclined planes.' },
    exploded_stack: { label: 'Explode gap', takeaway: 'Drag to orbit and scrub the gap to inspect each layer.' },
    surface: { label: 'Amplitude', takeaway: 'Peaks highlight in accent ink; troughs recede in neutral grey.' },
    custom: { label: 'Scale', takeaway: 'Drag anywhere on the canvas to orbit the 3D structure.' }
  };

  const sliderLabel = $derived(payload.paramLabel || DEFAULT_META[payload.preset]?.label || 'Parameter');
  const takeawayText = $derived(payload.takeaway || DEFAULT_META[payload.preset]?.takeaway || '');

  function token(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || fallback;
  }

  function resize() {
    if (!canvasEl) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvasEl.getBoundingClientRect();
    width = Math.max(240, Math.round(rect.width || 560));
    canvasEl.width = width * dpr;
    canvasEl.height = height * dpr;
    const ctx = canvasEl.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function project(x: number, y: number, z: number) {
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    const y2 = y * cx - z1 * sx;
    const z2 = y * sx + z1 * cx;
    const s = 420 / Math.max(90, 330 + z2);
    const a = Math.max(0.28, Math.min(1, 1 - (z2 + 120) / 360));
    return { x: width / 2 + x1 * s, y: height / 2 - y2 * s, z: z2, s, a };
  }

  function drawFrame() {
    const ctx = canvasEl?.getContext('2d');
    if (!ctx) return;
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (autoRotate && !dragging && !reduceMotion) rotY += 0.007;
    if (!reduceMotion) time += 0.022;

    const pv = param / 100;
    ctx.clearRect(0, 0, width, height);

    const acc = token('brand-accent', '#e8793a');
    const ink = token('foreground', '#ededed');
    const ink2 = token('text-secondary', '#a3a3a3');
    const ink3 = token('muted-foreground', '#6b6b6b');
    const line = token('border', 'rgba(255,255,255,0.16)');
    const bg = token('background', '#1c1c1c');
    const items: Array<{ z: number; draw: () => void }> = [];

    if (payload.preset === 'dna') {
      const pairs = 15, twist = 0.34 + pv * 0.44;
      for (let i = 0; i < pairs; i++) {
        const y = (i - 7) * 14, ang = i * twist, r = 62;
        const a = project(Math.cos(ang) * r, y, Math.sin(ang) * r);
        const b = project(-Math.cos(ang) * r, y, -Math.sin(ang) * r);
        items.push({
          z: (a.z + b.z) / 2,
          draw: () => {
            ctx.strokeStyle = i % 2 === 0 ? acc : ink3;
            ctx.globalAlpha = Math.min(a.a, b.a) * 0.55;
            ctx.lineWidth = 1.6 * ((a.s + b.s) / 2);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        });
        items.push({ z: a.z, draw: () => { ctx.globalAlpha = a.a; ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(a.x, a.y, 5 * a.s, 0, 6.283); ctx.fill(); } });
        items.push({ z: b.z, draw: () => { ctx.globalAlpha = b.a; ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(b.x, b.y, 5 * b.s, 0, 6.283); ctx.fill(); } });
      }
    } else if (payload.preset === 'molecule') {
      const len = 64 + pv * 26;
      const pts: Array<[number, number, number, number, string, string]> = [
        [0, 0, 0, 15, acc, 'C'],
        [1, 1, 1, 9, ink, 'H'],
        [-1, -1, 1, 9, ink, 'H'],
        [-1, 1, -1, 9, ink, 'H'],
        [1, -1, -1, 9, ink, 'H']
      ];
      const cp = project(0, 0, 0);
      pts.forEach(([x, y, z, r, col, l], i) => {
        const d = i ? Math.hypot(x, y, z) : 1;
        const pp = project((x / d) * (i ? len : 0), (y / d) * (i ? len : 0), (z / d) * (i ? len : 0));
        if (i) {
          items.push({
            z: (cp.z + pp.z) / 2,
            draw: () => {
              ctx.globalAlpha = 0.6; ctx.strokeStyle = line; ctx.lineWidth = 2.4 * pp.s;
              ctx.beginPath(); ctx.moveTo(cp.x, cp.y); ctx.lineTo(pp.x, pp.y); ctx.stroke();
            }
          });
        }
        items.push({
          z: pp.z,
          draw: () => {
            ctx.globalAlpha = pp.a; ctx.fillStyle = col;
            ctx.beginPath(); ctx.arc(pp.x, pp.y, r * pp.s, 0, 6.283); ctx.fill();
            ctx.fillStyle = i ? bg : '#fff';
            ctx.font = `600 ${Math.round(10 * pp.s)}px ui-monospace, monospace`;
            ctx.textAlign = 'center';
            ctx.fillText(l, pp.x, pp.y + 3.5 * pp.s);
            ctx.textAlign = 'start';
          }
        });
      });
    } else if (payload.preset === 'orbit') {
      const spd = 0.35 + pv * 1.9;
      const bodies: Array<[number, number, number, string, number, string]> = [
        [54, 1.8, 4.5, ink2, 0.08, 'Inner'],
        [92, 1.15, 6.5, acc, -0.09, 'Habitable'],
        [132, 0.72, 5.5, ink, 0.12, 'Mid'],
        [172, 0.42, 8.5, ink2, -0.06, 'Outer']
      ];
      bodies.forEach(([r, sp, sz, col, tilt, name], idx) => {
        const customName = payload.layers?.[idx]?.label || name;
        ctx.globalAlpha = 0.45; ctx.strokeStyle = line; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 0; k <= 64; k++) {
          const a = (k / 64) * 6.283;
          const pt = project(Math.cos(a) * r, Math.sin(a) * r * tilt, Math.sin(a) * r);
          if (k) ctx.lineTo(pt.x, pt.y); else ctx.moveTo(pt.x, pt.y);
        }
        ctx.stroke();
        const a = time * sp * spd;
        const pt = project(Math.cos(a) * r, Math.sin(a) * r * tilt, Math.sin(a) * r);
        items.push({
          z: pt.z,
          draw: () => {
            ctx.globalAlpha = pt.a; ctx.fillStyle = col;
            ctx.beginPath(); ctx.arc(pt.x, pt.y, sz * pt.s, 0, 6.283); ctx.fill();
            ctx.fillStyle = ink3; ctx.font = '10.5px ui-monospace, monospace';
            ctx.fillText(customName, pt.x + sz * pt.s + 6, pt.y + 3.5);
          }
        });
      });
      const sun = project(0, 0, 0);
      items.push({
        z: sun.z,
        draw: () => {
          ctx.globalAlpha = 0.16; ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(sun.x, sun.y, 24 * sun.s, 0, 6.283); ctx.fill();
          ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(sun.x, sun.y, 12 * sun.s, 0, 6.283); ctx.fill();
        }
      });
    } else if (payload.preset === 'exploded_stack') {
      const gap = 22 + pv * 40;
      const layers = payload.layers?.length
        ? payload.layers
        : [{ label: 'Storage' }, { label: 'Cache' }, { label: 'API Gateway' }, { label: 'Client', accent: true }];
      layers.forEach((layer, i) => {
        const y = (i - (layers.length - 1) / 2) * gap;
        const w = 92, d = 64;
        const isAcc = layer.accent || i === layers.length - 1;
        const col = isAcc ? acc : ink2;
        const cs = [project(-w, y, -d), project(w, y, -d), project(w, y, d), project(-w, y, d)];
        items.push({
          z: cs.reduce((s, c) => s + c.z, 0) / 4,
          draw: () => {
            ctx.beginPath();
            cs.forEach((c, ci) => (ci ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
            ctx.closePath();
            ctx.globalAlpha = isAcc ? 0.16 : 0.07; ctx.fillStyle = col; ctx.fill();
            ctx.globalAlpha = 0.85; ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.stroke();
            const lb = project(w + 16, y, 0);
            ctx.globalAlpha = 1; ctx.fillStyle = isAcc ? acc : ink2;
            ctx.font = '500 11.5px system-ui, sans-serif';
            ctx.fillText(layer.label, lb.x, lb.y + 4);
          }
        });
      });
    } else if (payload.preset === 'surface') {
      const N = 14, span = 124, amp = 12 + pv * 36;
      const g: Array<Array<{ x: number; y: number; z: number; h: number }>> = [];
      for (let i = 0; i <= N; i++) {
        g[i] = [];
        for (let j = 0; j <= N; j++) {
          const x = -span + (i / N) * span * 2;
          const z = -span + (j / N) * span * 2;
          const dist = Math.hypot(x, z) / 26;
          const y = Math.cos(dist - time * 1.2) * amp * Math.exp(-dist * 0.16);
          g[i][j] = { ...project(x, y, z), h: y };
        }
      }
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const q = [g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]];
          const avgH = (q[0].h + q[1].h + q[2].h + q[3].h) / 4;
          items.push({
            z: (q[0].z + q[1].z + q[2].z + q[3].z) / 4,
            draw: () => {
              ctx.beginPath();
              q.forEach((c, ci) => (ci ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
              ctx.closePath();
              ctx.fillStyle = avgH >= 0 ? acc : ink2;
              ctx.globalAlpha = 0.05 + Math.min(0.22, Math.abs(avgH) / 70); ctx.fill();
              ctx.strokeStyle = avgH >= 0 ? acc : ink3;
              ctx.globalAlpha = 0.42; ctx.lineWidth = 0.85; ctx.stroke();
            }
          });
        }
      }
    } else {
      // Custom declarative nodes + edges
      const scale = 0.6 + pv * 0.8;
      const nodes = payload.nodes ?? [];
      const byId = new Map<string, ReturnType<typeof project>>();
      const projected = nodes.map((node, index) => {
        const p = project(node.x * scale, node.y * scale, node.z * scale);
        if (node.id) byId.set(node.id, p);
        byId.set(String(index), p);
        return { node, p };
      });
      (payload.edges ?? []).forEach((edge) => {
        const a = byId.get(String(edge.from));
        const b = byId.get(String(edge.to));
        if (!a || !b) return;
        items.push({
          z: (a.z + b.z) / 2,
          draw: () => {
            ctx.globalAlpha = Math.min(a.a, b.a) * 0.7;
            ctx.strokeStyle = edge.accent ? acc : line;
            ctx.lineWidth = edge.accent ? 2 : 1.4;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        });
      });
      projected.forEach(({ node, p }) => {
        const r = (node.radius ?? 6) * p.s;
        items.push({
          z: p.z,
          draw: () => {
            ctx.globalAlpha = p.a;
            ctx.fillStyle = node.accent ? acc : ink;
            ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.283); ctx.fill();
            if (node.label) {
              ctx.fillStyle = node.accent ? acc : ink2;
              ctx.font = '11px ui-monospace, monospace';
              ctx.fillText(node.label, p.x + r + 5, p.y + 3.5);
            }
          }
        });
      });
    }

    items.sort((a, b) => b.z - a.z);
    items.forEach((it) => it.draw());
    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(drawFrame);
  }

  function onPointerDown(event: PointerEvent) {
    dragging = true;
    lastPointer = { x: event.clientX, y: event.clientY };
    (event.currentTarget as HTMLCanvasElement).setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging || !lastPointer) return;
    rotY += (event.clientX - lastPointer.x) * 0.01;
    rotX = Math.max(-1.2, Math.min(1.2, rotX + (event.clientY - lastPointer.y) * 0.01));
    lastPointer = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent) {
    dragging = false;
    lastPointer = null;
    (event.currentTarget as HTMLCanvasElement).releasePointerCapture?.(event.pointerId);
  }

  onMount(() => {
    resize();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    if (canvasEl) ro?.observe(canvasEl);
    rafId = requestAnimationFrame(drawFrame);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(rafId);
    };
  });

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
  });
</script>

<section class="viz-surface scene3d" aria-label={payload.title || '3D Scene'}>
  <header class="viz-header scene3d-head">
    <VizHeading kind="scene_3d" title={payload.title} subtitle={payload.subtitle} />
  </header>

  <div class="scene3d-stage">
    <canvas
      bind:this={canvasEl}
      class="scene3d-canvas"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    ></canvas>
  </div>

  <label class="scene3d-slider">
    <span class="scene3d-label">{sliderLabel}</span>
    <Range min={0} max={100} step={1} value={param} aria-label={sliderLabel} oninput={(e) => (param = Number(e.currentTarget.value))} />
    <span class="scene3d-val">{param}%</span>
  </label>

  <footer class="scene3d-footer">
    {#if takeawayText}
      <span class="scene3d-takeaway"><span class="scene3d-dot" aria-hidden="true"></span>{takeawayText}</span>
    {/if}
    <span class="spacer"></span>
    <Button variant="ghost" size="sm" onclick={() => (autoRotate = !autoRotate)}>{autoRotate ? 'Pause' : 'Rotate'}</Button>
    <Button variant="ghost" size="sm" onclick={() => { rotY = 0.55; rotX = 0.34; }}>Reset</Button>
  </footer>
</section>

<style>
  .scene3d {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .scene3d-head { margin-bottom: 0; }

  .scene3d-stage {
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--foreground) 3%, transparent);
    overflow: hidden;
  }

  .scene3d-canvas {
    display: block;
    width: 100%;
    height: 310px;
    cursor: grab;
    touch-action: none;
  }

  .scene3d-canvas:active { cursor: grabbing; }

  .scene3d-slider {
    display: grid;
    grid-template-columns: minmax(6rem, 26%) 1fr auto;
    align-items: center;
    gap: 0.75rem;
    font-size: var(--text-xs);
  }

  .scene3d-label { color: var(--text-secondary); font-weight: 500; }
  .scene3d-val { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--foreground); min-width: 2.5rem; text-align: right; }

  .scene3d-footer {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }

  .scene3d-takeaway {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .scene3d-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--brand-accent, var(--foreground));
    flex-shrink: 0;
  }

  .spacer { flex: 1; }
</style>
