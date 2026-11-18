// ── Vamp'd showcase ── In the product: web/components/LiveChart.tsx.
// The live market chart: canvas render loop, continuous time axis, critically damped springs, spring-eased y-scale.

"use client";
// The live chart (canvas, one render loop per chart, paused off-screen and in a hidden tab). Time is continuous: the
// x-axis scrolls with the clock every frame. The head rides the real line just under one sample behind the feed, so
// it is always travelling and never waits and jumps. New data never redraws the line: each drawn point springs to its
// real value (settled history is exactly the data). The y-scale moves rarely and as a spring; ticks and tags glide;
// the line and its fill are green above the line to beat and red below, blended across the crossover; a price tag
// rides the head; the close is a finish line; your picks drop onto the line; hover / touch-drag scrubs through time.
// No rings, no pulses. Reduced motion: nothing animates; values still update.
import { zoomOf } from "@/lib/zoom";
import { useEffect, useRef } from "react";

type Pt = [number, number];
/** side is null while a sealed market hides it. */
export type ChartPick = { t: number; side?: "yes" | "no" | null; amount?: number; mine?: boolean; label?: string };
export type Scrub = { t: number; v: number; v2?: number } | null;
export interface LiveChartProps {
  samples: Pt[];
  /** The line to beat (dashed). Above it is the yes colour, below it the no colour. Without it the line is ink. */
  target?: number;
  targetLabel?: string;
  closesAt?: number;
  /** When the starting price is fixed (two-phase price rounds). Until then the line to beat follows the price. */
  lockAt?: number;
  /** false once the market has settled: no pulse, the whole round is shown. */
  live?: boolean;
  fmt?: (n: number) => string;
  picks?: ChartPick[];
  /** Sealed market: the crowd's picks are drawn without their side. */
  sealed?: boolean;
  /** Battle: a second series on the same scale (both already in % from their open), with their names. */
  samples2?: Pt[];
  names?: [string, string];
  /** Right axis: distance from the line to beat in % (default with a target), or plain values (a goal to reach). */
  axis?: "rel" | "value";
  /** The figure the riding tag prints (the same one the header shows). Default: the latest sample. */
  tagValue?: number;
  /** A goal to reach, not a side to be on: the line is ink (no green / red). */
  neutral?: boolean;
  /** Counts: the value holds and steps, never slopes. */
  step?: boolean;
  /** full: axes, tags, crosshair. mini: just the line (cards). */
  size?: "full" | "compact" | "mini";
  onScrub?: (s: Scrub) => void;
  className?: string;
  label?: string;
}

const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
const TSTEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map(s => s * 1000);

/** The line is a monotone cubic through the real samples: it passes through every one of them and can never rise
 *  above a real high or dip below a real low (a flat stretch stays flat, a step stays a step). The tangents are
 *  held back, so it reads as the tape with its corners eased, not as a wave. */
function trace(ctx: CanvasRenderingContext2D, xs: number[], ys: number[]) {
  const n = xs.length; if (!n) return;
  ctx.moveTo(xs[0], ys[0]);
  if (n < 3) { for (let i = 1; i < n; i++) ctx.lineTo(xs[i], ys[i]); return; }
  const dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i] || 1e-6; m[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  for (let i = 0; i < n; i++) t[i] *= 0.5;
  for (let i = 0; i < n - 1; i++) if (dx[i] <= 2) ctx.lineTo(xs[i + 1], ys[i + 1]); else ctx.bezierCurveTo(xs[i] + dx[i] / 3, ys[i] + (t[i] * dx[i]) / 3, xs[i + 1] - dx[i] / 3, ys[i + 1] - (t[i + 1] * dx[i]) / 3, xs[i + 1], ys[i + 1]);
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = h / 2) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

type RGB = [number, number, number];
const rgbOf = (hex: string, d: RGB = [245, 245, 245]): RGB => {
  const h = hex.trim().replace("#", ""), f = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const n = /^[0-9a-f]{6}$/i.test(f) ? parseInt(f, 16) : NaN; return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : d;
};
const A = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a: RGB, b: RGB, k: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => { const k = clamp01(x); return k * k * (3 - 2 * k); };
/** Critically damped spring, integrated exactly (any frame length): eases in and out, never overshoots. */
const spring = (x: number, v: number, to: number, w: number, dt: number): [number, number] => { const e = x - to, tmp = (v + w * e) * dt, ex = Math.exp(-w * dt); return [to + (e + tmp) * ex, (v - w * tmp) * ex]; };

/** One line. T, V are the real samples (never altered). D is what is drawn: each drawn point springs to its real
 *  value, so new data bends the line into place instead of redrawing it, and settled history is exactly the data. */
type Series = { src: Pt[] | null; T: number[]; V: number[]; D: number[]; U: number[]; busy: boolean; med: number };
const mkS = (): Series => ({ src: null, T: [], V: [], D: [], U: [], busy: false, med: 1000 });
/** The drawn value at time t: straight between drawn points; the last one holds until the next trade. */
function evalD(S: Series, t: number) {
  const T = S.T, D = S.D, n = T.length; if (!n) return 0;
  if (t >= T[n - 1]) return D[n - 1]; if (t <= T[0]) return D[0];
  let a = 0, b = n - 1; while (b - a > 1) { const m = (a + b) >> 1; if (T[m] <= t) a = m; else b = m; }
  return D[a] + (D[b] - D[a]) * ((t - T[a]) / (T[b] - T[a] || 1));
}
/** Takes a new array of samples. A point that is new starts where the drawn line already is at that time (so nothing
 *  moves on the frame it arrives) and springs to its value; a revised point springs from where it was. Feeds that
 *  carry only the latest stretch (cards get the last 60) keep what was drawn before it. */
function sync(S: Series, pts: Pt[], anim: boolean) {
  if (S.src === pts) return false; S.src = pts;
  const n = pts.length, oT = S.T, oV = S.V, oD = S.D, oU = S.U, on = oT.length;
  const T: number[] = [], V: number[] = [], D: number[] = [], U: number[] = [];
  let busy = false;
  if (n) {
    let j = 0; const joined = on > 0 && pts[0][0] <= oT[on - 1] && pts[n - 1][0] >= oT[0], cont = anim && joined;
    if (joined && pts[0][0] > oT[0]) for (; j < on && oT[j] < pts[0][0]; j++) { T.push(oT[j]); V.push(oV[j]); D.push(oD[j]); U.push(oU[j]); if (oD[j] !== oV[j]) busy = true; }
    for (let i = 0; i < n; i++) {
      const t = pts[i][0], v = pts[i][1]; if (!Number.isFinite(t) || !Number.isFinite(v) || (T.length && t <= T[T.length - 1])) continue;
      while (j < on && oT[j] < t) j++;
      const same = j < on && oT[j] === t, d = !cont ? v : same ? oD[j] : t > oT[0] ? evalD(S, t) : v;
      T.push(t); V.push(v); D.push(d); U.push(cont && same ? oU[j] : 0); if (d !== v) busy = true;
    }
    const over = T.length - 900; if (over > 0) { T.splice(0, over); V.splice(0, over); D.splice(0, over); U.splice(0, over); }
  }
  const m = T.length; if (m > 2) { const g: number[] = []; for (let i = Math.max(1, m - 9); i < m; i++) g.push(T[i] - T[i - 1]); g.sort((x, y) => x - y); S.med = g[g.length >> 1]; }
  S.T = T; S.V = V; S.D = D; S.U = U; S.busy = busy;
  return true;
}
function stepS(S: Series, dt: number, eps: number, snap: boolean) {
  if (!S.busy) return;
  const T = S.T, V = S.V, D = S.D, U = S.U; let any = false;
  for (let i = T.length - 1; i >= 0; i--) {
    if (D[i] === V[i] && U[i] === 0) continue;
    if (!snap) { const r = spring(D[i], U[i], V[i], 9, dt); if (Math.abs(r[0] - V[i]) > eps || Math.abs(r[1]) > eps * 4) { D[i] = r[0]; U[i] = r[1]; any = true; continue; } }
    D[i] = V[i]; U[i] = 0;
  }
  S.busy = any;
}
const clockText = (t: number, secs: boolean) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: secs ? "2-digit" : undefined }).replace(/\s?[AP]M/i, "");

export function LiveChart(props: LiveChartProps) {
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const P = useRef(props), wake = useRef<() => void>(() => {});
  useEffect(() => { P.current = props; wake.current(); });
  const size = props.size ?? "full";

  useEffect(() => {
    const el = wrap.current, cv = canvas.current; if (!el || !cv) return;
    const c2d = cv.getContext("2d"); if (!c2d) return;
    const ctx: CanvasRenderingContext2D = c2d, host: HTMLDivElement = el;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const css = getComputedStyle(document.documentElement), v = (k: string, d: string) => rgbOf(css.getPropertyValue(k).trim() || d, rgbOf(d));
    const C = { yes: v("--yes", "#26d07c"), no: v("--no", "#ff5470"), ink: v("--ink", "#f5f5f5"), ink2: v("--ink-2", "#bdbdbd"), ink3: v("--ink-3", "#7a7a7a"), a: v("--coin-a", "#ff5a4d"), b: v("--coin-b", "#5aa9ff") };
    const mono = `${css.getPropertyValue("--font-num").trim() || "ui-monospace"}, ui-monospace, monospace`;
    let W = 0, H = 0, dpr = 1, raf = 0, visible = true, prev = 0, fresh = true, force = false, drawn = false;
    const S1 = mkS(), S2 = mkS();
    let closeKey: number | undefined;
    // the clock: frames run on the display's own timestamps; the feed's clock is learnt from when samples arrive
    let clock0 = Date.now() - performance.now(), offT = 0, shift: number | null = null, seenT = 0, winMax = -Infinity, winN = 0, winAt = 0;
    let hT = 0, t0d = 0, t1d = 0, prd = 0;
    let lo = 0, hi = 1, vlo = 0, vhi = 0, rLo: number | null = null, rHi = 0, shrinkAt = 0;
    let tg: number | null = null, vtg = 0, tgSeen: number | undefined, tgInit = false, tgChangedAt = -1e9, lockK = 1, wasLocked = true;
    let wasLive = false, flash = -1e9, flashUp = true, lockFx = -1e9, settleFx = -1e9, lastTick = 0, changedAt = Date.now(), lastV: number | null = null;
    let busyUntil = 0, propKey = "";
    const yTicks = new Map<string, { q: number; a: number; on: boolean; dec: number }>(), xTicks = new Map<number, { a: number; on: boolean; text: string }>();
    const born = new Map<string, number>(); let picksInit = false, closeText = "", closeTextKey = "";
    let hover: number | null = null; // css x of the crosshair
    let scrubbed = false, scrubKey = "";

    const resize = () => {
      // Layout size, not the on-screen rect: a rect read during the entrance animation (scaled) left the canvas
      // under-sized and soft. The backing store also follows the page zoom used on large screens (lib/zoom.ts).
      const d2 = Math.min(4, (devicePixelRatio || 1) * zoomOf(el)), w2 = Math.max(60, el.clientWidth), h2 = Math.max(30, el.clientHeight);
      if (d2 === dpr && w2 === W && h2 === H) return;
      dpr = d2; W = w2; H = h2; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      // sizing the canvas clears it: draw again at once (same frame), so a resize in mid-motion never shows a blank chart
      if (drawn) { cancelAnimationFrame(raf); raf = 0; force = true; frame(performance.now()); }
    };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();
    addEventListener("resize", resize); // the page zoom or the display scale changed without the box changing (fixed-size mini charts)
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); }); io.observe(el);
    const onVis = () => { if (document.visibilityState === "visible") kick(); };
    document.addEventListener("visibilitychange", onVis);

    function frame(ts: number) {
      raf = 0;
      const p = P.current, mini = (p.size ?? "full") === "mini", compact = p.size === "compact";
      const still = reduce.matches, gap = prev ? Math.max(0, ts - prev) : 16.7;
      // cards draw every other frame: at their size a frame of travel is a hundredth of a pixel
      if (mini && !still && !force && prev && gap < 30) { raf = requestAnimationFrame(frame); return; }
      force = false; prev = Math.max(prev, ts);
      if (!host.dataset.on) host.dataset.on = "1"; // first frame drawn: the canvas fades in (CSS) instead of popping
      if (p.closesAt !== closeKey) { closeKey = p.closesAt; S1.T = []; S1.src = null; S2.T = []; S2.src = null; fresh = true; seenT = 0; offT = 0; winN = 0; winMax = -Infinity; born.clear(); picksInit = false; yTicks.clear(); xTicks.clear(); lastV = null; tgInit = false; }
      // First frame, reduced motion, or back from a hidden tab / a stall: land on the present, do not replay the gap.
      const snap = still || fresh || gap > 300; fresh = false;
      const dt = gap / 1000;
      const real = Date.now(); let wall = clock0 + prev; if (Math.abs(real - wall) > 250) { clock0 = real - prev; wall = real; }
      const c1 = sync(S1, p.samples || [], !snap), c2 = sync(S2, p.samples2 || [], !snap);
      const n = S1.T.length;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.lineCap = "round";
      drawn = true;

      if (!n) { // waiting for the first trade: the line to beat and a resting dot
        const y = Math.round(H / 2) + 0.5;
        ctx.strokeStyle = A(C.ink3, 0.5); ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(W - 12, y); ctx.stroke(); ctx.setLineDash([]);
        if (!mini) {
          ctx.fillStyle = A(C.ink2); ctx.beginPath(); ctx.arc(18, y, 3.5, 0, 7); ctx.fill();
          ctx.font = `500 12px ${mono}`; ctx.fillStyle = A(C.ink3); ctx.textAlign = "left"; ctx.fillText("Waiting for the first trade", 34, y - 14);
        }
        fresh = true; return;
      }

      const duo = S2.T.length > 0, n2 = S2.T.length, fmt = p.fmt ?? String;
      const first = S1.T[0], lastT1 = S1.T[n - 1], lastVal = S1.V[n - 1], lastT = duo ? Math.max(lastT1, S2.T[n2 - 1]) : lastT1;

      // The feed's clock. A sample cannot arrive before it was made, so the newest "sample time minus arrival time"
      // is how far this device's clock is from the feed's (plus the delivery delay): a wrong device clock no longer
      // parks the head on the last sample or lets it run ahead of the data.
      if (lastT1 > seenT) {
        const cand = lastT1 - real;
        if (!seenT) { offT = Math.max(0, cand); winAt = real; }
        else if (p.live !== false) { if (cand > offT) offT = cand; if (cand > winMax) winMax = cand; winN++; if (real - winAt > 6000 && winN >= 3) { offT = winMax; winMax = -Infinity; winN = 0; winAt = real; } }
        seenT = lastT1;
      }
      // The head runs just under one sample behind the feed: it is then always travelling along a line that is already
      // known, instead of waiting flat for the next sample and bending afterwards. Time never runs backwards.
      const to = offT - (p.step ? 200 : Math.min(1200, Math.max(200, 0.9 * S1.med)));
      if (shift == null || snap || Math.abs(to - shift) > 8000) shift = to;
      else shift += Math.max(-500 * dt, Math.min(3000 * dt, (to - shift) * (1 - Math.exp(-dt / 0.5))));
      const dispT = wall + shift;
      const live = p.live !== false && (!p.closesAt || dispT < p.closesAt);
      // head time: the present while live; at the close the last price is held to the finish line
      const hTo = live ? Math.max(first, Math.min(dispT, p.closesAt ?? Infinity)) : p.closesAt && lastT < p.closesAt && p.closesAt - lastT < 5000 ? p.closesAt : lastT;
      hT = live || snap || !hT ? hTo : hT + (hTo - hT) * (1 - Math.exp(-dt / 0.22));

      // drawn points spring to their real values; the line to beat does the same
      const eps = (hi - lo) * 2e-4 || Math.abs(lastVal) * 1e-7;
      stepS(S1, dt, eps, snap); stepS(S2, dt, eps, snap);
      if (p.target == null) tg = null;
      else if (tg == null || snap) { tg = p.target; vtg = 0; }
      else { [tg, vtg] = spring(tg, vtg, p.target, 10, dt); if (Math.abs(tg - p.target) < eps && Math.abs(vtg) < eps * 4) { tg = p.target; vtg = 0; } }
      if (!tgInit) { tgInit = true; tgSeen = p.target; } else if (p.target !== tgSeen) { tgSeen = p.target; tgChangedAt = ts; }
      // Until the starting price is set the line to beat follows the price: the tape is ink, and takes its sides the
      // moment the line is fixed.
      const locked = p.lockAt ? dispT >= p.lockAt : ts - tgChangedAt > 2500;
      if (snap) lockK = locked ? 1 : 0; else { lockK += ((locked ? 1 : 0) - lockK) * (1 - Math.exp(-dt / 0.25)); if (locked && !wasLocked) lockFx = ts; }
      if (Math.abs((locked ? 1 : 0) - lockK) < 0.004) lockK = locked ? 1 : 0;
      wasLocked = locked;

      // a big move brightens the head and washes the plot once (no rings)
      if (lastV != null && lastVal !== lastV) {
        const rel = Math.abs(lastVal - lastV) / ((hi - lo) || 1);
        if (!snap && rel > 0.16 && ts - lastTick > 500) { flash = ts; flashUp = lastVal > lastV; }
        lastTick = ts;
      }
      if (lastV == null || lastVal !== lastV) changedAt = real;
      lastV = lastVal;
      // Nothing has traded for a while: the line holds flat (true) and the chart says so.
      const quietMs = live ? real - changedAt : 0, quiet = quietMs > 20_000;

      // time window: the head sits ~70% across until the close comes into view, then runs into it (early in
      // a round the view is close in, so the line always fills most of the plot). The window itself glides.
      const t0 = duo ? Math.min(first, S2.T[0]) : first;
      let t1: number;
      if (p.closesAt && live) { const total = Math.max(1000, p.closesAt - t0), minD = Math.min(total, Math.max(15_000, total * 0.12)); t1 = t0 + Math.min(total, Math.max(minD, (hT - t0) / 0.7)); }
      else if (p.closesAt) t1 = Math.max(lastT, Math.min(p.closesAt, lastT + (lastT - t0) * 0.06));
      else t1 = t0 + Math.max(10_000, hT - t0) / (live ? 0.9 : 1);
      if (snap || !t1d) { t0d = t0; t1d = t1; } else { const k = 1 - Math.exp(-dt / 0.22); t0d += (t0 - t0d) * k; t1d += (t1 - t1d) * k; }

      // value range. It only moves when the line comes near an edge (then it makes room in one go) or has left a
      // lot of the plot empty for a while; the move itself is a spring. Otherwise the scale stands still.
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < n; i++) { const y = S1.D[i]; if (y < a) a = y; if (y > b) b = y; }
      for (let i = 0; i < n2; i++) { const y = S2.D[i]; if (y < a) a = y; if (y > b) b = y; }
      if (tg != null) { a = Math.min(a, tg); b = Math.max(b, tg); }
      const mid = (a + b) / 2, minSpan = duo ? 0.4 : Math.abs(mid) * 0.004 || 1;
      if (b - a < minSpan) { a = mid - minSpan / 2; b = mid + minSpan / 2; }
      const padF = mini ? 0.12 : 0.14, sp0 = b - a, w0 = a - sp0 * padF, w1 = b + sp0 * padF;
      if (rLo == null || snap) { rLo = lo = w0; rHi = hi = w1; vlo = vhi = 0; shrinkAt = 0; }
      else {
        const edge = (rHi - rLo) * 0.05;
        if (b > rHi - edge) rHi = b + sp0 * (padF + 0.08);
        if (a < rLo + edge) rLo = a - sp0 * (padF + 0.08);
        if (w1 - w0 < (rHi - rLo) * 0.7) { if (!shrinkAt) shrinkAt = ts; else if (ts - shrinkAt > (live ? 1500 : 0)) { rLo = w0; rHi = w1; shrinkAt = 0; } } else shrinkAt = 0;
        [lo, vlo] = spring(lo, vlo, rLo, 6.5, dt); [hi, vhi] = spring(hi, vhi, rHi, 6.5, dt);
        if (Math.abs(lo - rLo) + Math.abs(hi - rHi) < (rHi - rLo) * 2e-4) { lo = rLo; hi = rHi; vlo = vhi = 0; }
      }
      const scaling = lo !== rLo || hi !== rHi || (tg != null && tg !== p.target);
      const crisp = (y: number) => (scaling ? y : Math.round(y) + 0.5); // hairlines glide while the scale moves and sit on the pixel grid at rest

      // layout
      ctx.font = `600 12px ${mono}`;
      // the right gutter is as wide as its widest label (tag, axis label, or a battle's "name +1.2%")
      const relAxis = p.axis !== "value" && tg != null && !duo && p.target !== 0;
      const edgeLab = (val: number) => (relAxis ? `+${Math.abs((val / tg! - 1) * 100).toFixed(1)}%` : fmt(val));
      ctx.font = `500 10.5px ${mono}`; const tickW = mini || duo ? 0 : Math.ceil(Math.max(ctx.measureText(edgeLab(rHi)).width, ctx.measureText(edgeLab(rLo)).width)) + 26;
      ctx.font = `600 12px ${mono}`; const duoLab = (name: string, val: number) => `${name} ${val >= 0 ? "+" : "−"}${Math.abs(val).toFixed(1)}%`;
      const duoW = duo && !mini ? Math.ceil(Math.max(ctx.measureText(duoLab(p.names?.[0] ?? "", lastVal)).width, ctx.measureText(duoLab(p.names?.[1] ?? "", S2.V[n2 - 1] ?? 0)).width)) + 30 : 0;
      const headText = duo ? "" : fmt(p.tagValue ?? lastVal), tagW = mini ? 0 : duo ? 0 : Math.ceil(Math.max(ctx.measureText(headText).width, p.target != null ? ctx.measureText(fmt(p.target)).width : 0)) + 18;
      const PRt = mini ? 10 : duo ? duoW : Math.max(tagW + 12, tickW);
      prd = snap || !prd ? PRt : prd + (PRt - prd) * (1 - Math.exp(-dt / 0.12)); if (Math.abs(PRt - prd) < 0.05) prd = PRt;
      const PL = mini ? 2 : 4, PR = prd, PT = mini ? 4 : compact ? 18 : 16, PB = mini ? 4 : 26;
      const pw = W - PL - PR, ph = H - PT - PB, span = hi - lo || 1;
      const X = (t: number) => PL + ((t - t0d) / (t1d - t0d || 1)) * pw, Y = (val: number) => PT + (1 - (val - lo) / span) * ph;
      const yT = tg != null ? Y(tg) : null;
      const sided = p.target != null && !p.neutral;
      const sideOf = (val: number) => (!sided ? C.ink : val >= p.target! ? C.yes : C.no);
      const kf = snap ? 1 : 1 - Math.exp(-dt / 0.14);
      let fading = false;

      // y ticks: % from the line to beat (or plain values), hairlines. They ride the scale; a tick that comes or goes fades.
      if (!mini) {
        ctx.font = `500 10.5px ${mono}`; ctx.textAlign = "left";
        const rel = relAxis, want = compact ? 4 : 5;
        const dLo = rel ? (rLo / tg! - 1) * 100 : rLo, dHi = rel ? (rHi / tg! - 1) * 100 : rHi;
        let step = (dHi - dLo) / want;
        if (rel || duo) step = NICE.find(x => x >= step) ?? step; else { const mag = 10 ** Math.floor(Math.log10(step || 1)); step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= step) ?? step; }
        const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0, headY = duo ? -99 : Y(evalD(S1, hT));
        for (const tk of yTicks.values()) tk.on = false;
        for (let q = Math.ceil(dLo / step) * step, i = 0; q <= dHi + 1e-9 && i < 40; q += step, i++) { const key = q.toPrecision(9); const tk = yTicks.get(key); if (tk) { tk.on = true; tk.dec = dec; } else yTicks.set(key, { q, a: snap ? 1 : 0, on: true, dec }); }
        for (const [key, tk] of yTicks) {
          tk.a += ((tk.on ? 1 : 0) - tk.a) * kf; if (Math.abs((tk.on ? 1 : 0) - tk.a) < 0.02) tk.a = tk.on ? 1 : 0; else fading = true;
          if (!tk.on && tk.a === 0) { yTicks.delete(key); continue; }
          const q = tk.q, val = rel ? tg! * (1 + q / 100) : q, y0 = Y(val), y = crisp(y0);
          const al = tk.a * clamp01(Math.min(y0 - PT, H - PB - y0) / 8); if (al <= 0) continue;
          const isLine = (rel || duo) && Math.abs(q) < step / 1000;
          if (!isLine) { ctx.strokeStyle = `rgba(255,255,255,${0.045 * al})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke(); }
          if (isLine || (!rel && p.target != null && fmt(val) === fmt(p.target))) continue;
          if (p.step && !Number.isInteger(+val.toFixed(6))) continue; // counts: whole numbers only
          // a label gives way (fades) as the riding tag or the line's tag passes over it
          const la = al * (duo ? 1 : clamp01((Math.abs(y0 - headY) - 12) / 8) * (yT != null ? clamp01((Math.abs(y0 - yT) - 12) / 8) : 1)); if (la <= 0) continue;
          ctx.fillStyle = A(C.ink3, 0.85 * la); ctx.fillText(rel || duo ? `${q > 0 ? "+" : q < 0 ? "−" : ""}${Math.abs(q).toFixed(tk.dec)}%` : fmt(val), duo ? PL + 4 : W - PR + 14, duo ? y0 - 8 : y0);
        }
      }

      // time axis: labels scroll with the clock
      const settleK = ts - settleFx < 900 ? (ts - settleFx) / 900 : 1;
      if (!mini) {
        const dur = t1d - t0d, step = TSTEPS.find(x => dur / x <= Math.max(3, Math.floor(pw / 84))) ?? TSTEPS[TSTEPS.length - 1];
        const secs = step < 60_000, closeX = p.closesAt && p.closesAt <= t1d + 1 ? X(p.closesAt) : null;
        ctx.font = `500 10.5px ${mono}`; ctx.textAlign = "center";
        for (const tk of xTicks.values()) tk.on = false;
        for (let t = Math.ceil(t0d / step) * step, i = 0; t <= t1d && i < 40; t += step, i++) { const tk = xTicks.get(t); if (tk) tk.on = true; else xTicks.set(t, { a: snap ? 1 : 0, on: true, text: clockText(t, secs) }); }
        for (const [t, tk] of xTicks) {
          tk.a += ((tk.on ? 1 : 0) - tk.a) * kf; if (Math.abs((tk.on ? 1 : 0) - tk.a) < 0.02) tk.a = tk.on ? 1 : 0; else fading = true;
          if (!tk.on && tk.a === 0) { xTicks.delete(t); continue; }
          const x = X(t), al = tk.a * clamp01((x - PL - 14) / 12) * clamp01((W - PR - 14 - x) / 12) * (closeX != null ? clamp01((closeX - x - 112) / 16) : 1); if (al <= 0) continue;
          ctx.fillStyle = A(C.ink3, 0.85 * al); ctx.fillText(tk.text, x, H - 11);
        }
        if (closeX != null) { // the finish line (it lights up for a moment when the round ends)
          const x = scaling || live ? closeX : Math.round(closeX) - 0.5, ck = `${p.closesAt}:${secs}:${live}`;
          if (ck !== closeTextKey) { closeTextKey = ck; closeText = `${live ? "closes" : "closed"} ${clockText(p.closesAt!, secs && !!(p.closesAt! % 60_000))}`; }
          ctx.strokeStyle = A(C.ink, (live ? 0.32 : 0.18) + 0.5 * (1 - settleK) ** 2); ctx.lineWidth = 1; ctx.setLineDash([1, 4]); ctx.beginPath(); ctx.moveTo(x, PT - 6); ctx.lineTo(x, H - PB); ctx.stroke(); ctx.setLineDash([]);
          ctx.textAlign = "right"; ctx.fillStyle = A(C.ink2); ctx.fillText(closeText, x, H - 11);
        }
      }

      // the line to beat (at the lock it is drawn across once, bright, and settles)
      const lockT = ts - lockFx < 1100 ? (ts - lockFx) / 1100 : 1;
      if (yT != null) {
        const y = crisp(yT);
        ctx.strokeStyle = A(C.ink, (mini ? 0.28 : 0.42) + 0.3 * (1 - lockT)); ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR + (mini ? 0 : 4), y); ctx.stroke(); ctx.setLineDash([]);
        if (lockT < 1) { const e = 1 - (1 - Math.min(1, lockT * 2)) ** 3; ctx.strokeStyle = A(C.ink, 0.85 * (1 - lockT) ** 1.5); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL + (pw + 4) * e, y); ctx.stroke(); }
      }

      // series: the real points up to the head, then the head itself
      const perPx = (t1d - t0d) / (pw || 1), beat = p.closesAt ? Math.max(1000, (p.closesAt - t0) / 300) : 0;
      const build = (S: Series) => {
        const T = S.T, D = S.D, m = T.length, xs: number[] = [], ys: number[] = [], h = Math.max(hT, T[0]);
        const push = (t: number, val: number) => { const x = X(t), y = Y(val), k = xs.length; if (k && x - xs[k - 1] < 0.5) { ys[k - 1] = y; return; } xs.push(x); ys.push(y); };
        // A quiet stretch is not a slope: across a gap much longer than the feed's own cadence (one sample a second on
        // short rounds; 2.5 beats without a sample means nothing traded) the last price holds, then steps to the
        // next trade. (A smooth arc over minutes without trades drew a move that never happened.)
        const lim = beat ? Math.max(3 * perPx, 2.5 * beat) : Math.max(14 * perPx, S.med * 3);
        let hv = D[0];
        push(T[0], D[0]);
        for (let i = 1; i < m; i++) {
          const t = T[i], val = D[i], pt = T[i - 1], pv = D[i - 1], g = t - pt;
          const hold = (!!p.step || g > lim) && val !== pv, tr = hold ? t - Math.min(3 * perPx, g * 0.2) : pt; // where the move starts
          if (t > h) { // the head is inside this stretch
            if (hold && h > tr) push(tr, pv);
            hv = h <= tr ? pv : pv + (val - pv) * ((h - tr) / (t - tr || 1));
            break;
          }
          if (hold) push(tr, pv);
          push(t, val); hv = val;
        }
        const hx = X(h), hy = Y(hv), k = xs.length; // the last price holds until the next trade
        if (hx - xs[k - 1] < 0.5) { if (k > 1) { xs[k - 1] = Math.max(hx, xs[k - 2] + 0.01); ys[k - 1] = hy; } else ys[0] = hy; } else { xs.push(hx); ys.push(hy); }
        return { xs, ys, hx: xs[xs.length - 1], hy, hv };
      };
      const G = build(S1), hx = G.hx, hy = G.hy;
      const lw = mini ? 1.5 : 1.75;
      const strokeLine = (g: { xs: number[]; ys: number[] }, style: (al: number) => string | CanvasGradient) => {
        if (!mini && pw / g.xs.length > 4) { ctx.strokeStyle = style(0.08); ctx.lineWidth = 5; ctx.beginPath(); trace(ctx, g.xs, g.ys); ctx.stroke(); }
        ctx.strokeStyle = style(1); ctx.lineWidth = pw / g.xs.length > 2.5 ? lw : 1.5; ctx.beginPath(); trace(ctx, g.xs, g.ys); ctx.stroke();
      };
      const env = (t: number, len: number) => { const k = (ts - t) / len; return k < 0 || k >= 1 ? 0 : k < 0.12 ? k / 0.12 : ((1 - k) / 0.88) ** 2; }; // quick rise, long fall
      if (duo) {
        const B = build(S2);
        strokeLine(B, al => A(C.b, al)); strokeLine(G, al => A(C.a, al));
        const heads: [number, number, RGB, string, number][] = [[hx, hy, C.a, p.names?.[0] ?? "", G.hv], [B.hx, B.hy, C.b, p.names?.[1] ?? "", B.hv]];
        let ya = heads[0][1], yb = heads[1][1]; if (Math.abs(ya - yb) < 26) { const m2 = (ya + yb) / 2, up = ya <= yb, k = smooth(Math.abs(ya - yb) / 26); ya = ya * k + (m2 + (up ? -13 : 13)) * (1 - k); yb = yb * k + (m2 + (up ? 13 : -13)) * (1 - k); }
        heads.forEach(([x, y, col, name, val], i) => {
          ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fill(); ctx.fillStyle = A(col); ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 7); ctx.fill();
          if (!mini) { const ty = Math.min(H - PB - 11, Math.max(PT + 11, i ? yb : ya)), lab = duoLab(name, val); ctx.font = `600 12px ${mono}`; const tw = ctx.measureText(lab).width + 16; ctx.fillStyle = A(col); pill(ctx, W - PR + 6, ty - 11, tw, 22, 7); ctx.fill(); ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.fillText(lab, W - PR + 6 + tw / 2, ty + 0.5); }
        });
      } else {
        const base = yT != null ? Math.min(H - PB, Math.max(PT, yT)) : H - PB, floor = H - PB;
        const area = (to: number) => { ctx.beginPath(); trace(ctx, G.xs, G.ys); ctx.lineTo(hx, to); ctx.lineTo(G.xs[0], to); ctx.closePath(); };
        let yMin = Infinity, yMax = -Infinity; for (const y of G.ys) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
        const al = mini ? 0.2 : 0.26, sideK = sided ? lockK : 0;
        // The sides blend: the stroke is one gradient that turns from green to red across a few pixels around the line
        // to beat, the fills fade to nothing at it, and the head takes the mixed colour, so a crossing is never a flip.
        const BL = 5, cy = mix(C.ink, C.yes, sideK), cn = mix(C.ink, C.no, sideK);
        const headC = sideK ? mix(cy, cn, smooth((hy - base + BL) / (2 * BL))) : C.ink;
        if (sideK < 1) { // no sides (a goal market, or the starting price is not set yet): fills down to the axis, like a plain series
          const g = ctx.createLinearGradient(0, yMin, 0, floor); g.addColorStop(0, A(C.ink, 0.12 * (1 - sideK))); g.addColorStop(1, A(C.ink, 0));
          ctx.fillStyle = g; area(floor); ctx.fill();
        }
        if (sideK > 0) for (const above of [true, false]) {
          if (above ? yMin >= base : yMax <= base) continue;
          const col = above ? C.yes : C.no;
          ctx.save(); ctx.beginPath(); if (above) ctx.rect(0, 0, W, base); else ctx.rect(0, base, W, H - base); ctx.clip();
          const g = ctx.createLinearGradient(0, above ? Math.min(yMin, base - 40) : Math.max(yMax, base + 40), 0, base); g.addColorStop(0, A(col, al * sideK)); g.addColorStop(1, A(col, 0));
          ctx.fillStyle = g; area(base); ctx.fill(); ctx.restore();
        }
        strokeLine(G, sideK ? a2 => { const g = ctx.createLinearGradient(0, base - BL, 0, base + BL); g.addColorStop(0, A(cy, a2)); g.addColorStop(1, A(cn, a2)); return g; } : a2 => A(C.ink, a2));

        // the crowd's picks: a quiet strip on the time axis; yours drop onto the line
        const picks = p.picks || [];
        if (!mini && (picks.length || picksInit)) {
          const lastMine = picks.filter(q => q.mine).sort((x, y) => y.t - x.t)[0];
          for (const pk of picks) {
            const id = `${pk.t}:${pk.mine ? 1 : 0}:${pk.side ?? ""}`; let b0 = born.get(id); if (b0 == null) { b0 = picksInit && !snap ? ts : -1e9; born.set(id, b0); }
            const k0 = clamp01((ts - b0) / 480), e = 1 - (1 - k0) ** 3; if (k0 < 1) fading = true;
            if (pk.t < t0d || pk.t > t1d) continue; const x = X(Math.min(pk.t, hT));
            if (!pk.mine) { ctx.fillStyle = p.sealed || !pk.side ? A(C.ink3, 0.7 * e) : A(pk.side === "yes" ? C.yes : C.no, 0.75 * e); ctx.fillRect(x - 1, H - PB - 5 * e, 2, 5 * e); continue; }
            const y1 = Y(evalD(S1, Math.min(pk.t, hT))), y = y1 - 18 * (1 - e), col = pk.side === "yes" ? C.yes : C.no;
            ctx.strokeStyle = A(col, 0.5 * e); ctx.lineWidth = 1; ctx.setLineDash([1, 3]); ctx.beginPath(); if (y1 > PT + ph * 0.55) { ctx.moveTo(x, y1 - 7); ctx.lineTo(x, PT + 18); } else { ctx.moveTo(x, y1 + 7); ctx.lineTo(x, H - PB - 8); } ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = `rgba(0,0,0,${e})`; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 7); ctx.fill();
            ctx.strokeStyle = A(col, e); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.stroke();
            if (pk !== lastMine) continue; // several picks: every one gets its mark, only the latest carries the flag
            const text = pk.label ?? "You"; ctx.font = `600 10.5px ${mono}`; const tw = ctx.measureText(text).width + 14;
            const bx = Math.min(W - PR - tw - 2, Math.max(PL + 2, x - tw / 2)), low = y1 > PT + ph * 0.55, by = low ? PT : H - PB - 26; // the flag stands on the time axis (or hangs from the top), clear of the line
            ctx.fillStyle = `rgba(0,0,0,${e})`; pill(ctx, bx, by, tw, 18); ctx.fill(); ctx.strokeStyle = A(col, 0.6 * e); ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = A(col, e); ctx.textAlign = "center"; ctx.fillText(text, bx + tw / 2, by + 9.5);
          }
        }
        picksInit = true;

        // head: connector to the riding tag, a soft still glow, the dot
        const glowK = Math.max(env(flash, 800), env(settleFx, 900), env(lockFx, 900) * 0.6);
        if (!mini) {
          const ty = Math.min(H - PB - 11, Math.max(PT + 1, hy));
          ctx.strokeStyle = A(headC, 0.45); ctx.lineWidth = 1; ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(hx + 8, hy); ctx.lineTo(W - PR + 6, hy); ctx.stroke(); ctx.setLineDash([]);
          if (yT != null && !(fmt(p.target!) === headText && Math.abs(yT - hy) < 30)) { // the line's own tag, pushed clear of the riding tag (one tag is enough while both read the same)
            let y2 = yT; if (Math.abs(y2 - ty) < 28) y2 = ty + (yT <= hy ? -28 : 28);
            if (y2 < PT + 1) y2 = ty + 28; if (y2 > H - PB - 11) y2 = ty - 28;
            ctx.font = `500 12px ${mono}`; ctx.fillStyle = "#000"; pill(ctx, W - PR + 6, y2 - 11, tagW, 22, 7); ctx.fill(); ctx.strokeStyle = `rgba(255,255,255,${0.2 + 0.6 * env(lockFx, 1100)})`; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = A(C.ink2); ctx.textAlign = "center"; ctx.fillText(fmt(p.target!), W - PR + 6 + tagW / 2, y2 + 0.5);
          }
          ctx.fillStyle = A(headC); pill(ctx, W - PR + 6, ty - 11, tagW, 22, 7); ctx.fill();
          ctx.font = `600 12px ${mono}`; ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.fillText(headText, W - PR + 6 + tagW / 2, ty + 0.5);
          // no ring at the head (user request): a soft glow that stays put, and only brightens on a big move, the lock and the close
          const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 24); g.addColorStop(0, A(headC, (live ? 0.28 : 0.16) + 0.4 * glowK)); g.addColorStop(1, A(headC, 0)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, hy, 24, 0, 7); ctx.fill();
          if (ts - flash < 700) { const k = (ts - flash) / 700, g2 = ctx.createLinearGradient(0, flashUp ? PT : H - PB, 0, flashUp ? H - PB : PT); g2.addColorStop(0, A(headC, 0.1 * env(flash, 700))); g2.addColorStop(1, A(headC, 0)); ctx.fillStyle = g2; ctx.fillRect(PL, PT, pw, ph); void k; }
        }
        ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(hx, hy, mini ? 3.6 : 6, 0, 7); ctx.fill();
        ctx.fillStyle = A(headC); ctx.beginPath(); ctx.arc(hx, hy, mini ? 2.4 : 4, 0, 7); ctx.fill();
        if (quiet && !mini) { const sec = Math.floor(quietMs / 1000); ctx.font = `500 10.5px ${mono}`; ctx.textAlign = "left"; ctx.fillStyle = A(C.ink3, 0.9); ctx.fillText(`Quiet · no trades for ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`, PL + 8, PT + 8); }
      }

      // crosshair
      if (!mini && hover != null) {
        const x = Math.min(hx, Math.max(G.xs[0], hover)), t = t0d + ((x - PL) / pw) * (t1d - t0d);
        const va = x >= hx ? G.hv : evalD(S1, t), vb = duo ? evalD(S2, t) : undefined, xr = Math.round(x) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xr, PT + 26); ctx.lineTo(xr, H - PB); ctx.stroke();
        const dot = (y: number, col: RGB) => { ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.strokeStyle = A(col); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4.2, 0, 7); ctx.stroke(); };
        dot(Y(va), duo ? C.a : sideOf(va)); if (vb != null) dot(Y(vb), C.b);
        const time = new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }).replace(/\s?[AP]M/i, "");
        const main = duo ? `${va >= 0 ? "+" : ""}${va.toFixed(2)}%  ${vb! >= 0 ? "+" : ""}${vb!.toFixed(2)}%` : fmt(va);
        const delta = !duo && p.target ? `${va >= p.target ? "+" : "−"}${Math.abs((va / p.target - 1) * 100).toFixed(2)}%` : "";
        ctx.font = `600 12px ${mono}`; const w1 = ctx.measureText(main).width, w2 = delta ? ctx.measureText(delta).width + 10 : 0; ctx.font = `500 11px ${mono}`; const w3 = ctx.measureText(time).width;
        const tw = w1 + w2 + w3 + 34, bx = Math.min(W - PR - tw, Math.max(PL, x - tw / 2)), by = PT - 2;
        ctx.fillStyle = "#0a0a0a"; pill(ctx, bx, by, tw, 26, 13); ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.stroke();
        ctx.textAlign = "left"; ctx.font = `600 12px ${mono}`; ctx.fillStyle = A(C.ink); ctx.fillText(main, bx + 12, by + 13.5);
        if (delta) { ctx.fillStyle = A(sideOf(va)); ctx.fillText(delta, bx + 12 + w1 + 10, by + 13.5); }
        ctx.font = `500 11px ${mono}`; ctx.fillStyle = A(C.ink3); ctx.fillText(time, bx + 12 + w1 + w2 + 10, by + 13.5);
        const sk = `${Math.round(x)}:${main}`; scrubbed = true; if (sk !== scrubKey) { scrubKey = sk; P.current.onScrub?.({ t, v: va, v2: vb }); }
      } else if (scrubbed) { scrubbed = false; scrubKey = ""; P.current.onScrub?.(null); }

      // keep drawing while something moves; a settled chart rests until its data or the pointer changes
      const key = `${W}:${H}:${hover}:${p.picks?.length ?? 0}:${p.target}:${headText}:${p.live}`;
      if (c1 || c2 || key !== propKey || fading) { propKey = key; busyUntil = Math.max(busyUntil, ts + 900); }
      if (live !== wasLive) { if (wasLive && !snap) settleFx = ts; wasLive = live; busyUntil = Math.max(busyUntil, ts + 1500); }
      const active = live || S1.busy || S2.busy || scaling || lockK % 1 !== 0 || ts < busyUntil;
      if (visible && document.visibilityState === "visible" && active && !still) raf = requestAnimationFrame(frame);
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    wake.current = kick;
    kick();
    // a safety net for a resting chart, and the once-a-second redraw for reduced motion
    const poll = setInterval(() => { if (visible && !raf) kick(); }, 1000);

    const pos = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); hover = (e.clientX - r.left) * (r.width ? W / r.width : 1); kick(); };
    const leave = () => { hover = null; kick(); };
    const interactive = (P.current.size ?? "full") !== "mini";
    if (interactive) { cv.addEventListener("pointermove", pos); cv.addEventListener("pointerdown", pos); cv.addEventListener("pointerleave", leave); cv.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") leave(); }); cv.addEventListener("pointercancel", leave); }
    return () => { wake.current = () => {}; cancelAnimationFrame(raf); clearInterval(poll); ro.disconnect(); removeEventListener("resize", resize); io.disconnect(); document.removeEventListener("visibilitychange", onVis); cv.removeEventListener("pointermove", pos); cv.removeEventListener("pointerdown", pos); cv.removeEventListener("pointerleave", leave); cv.removeEventListener("pointercancel", leave); };
  }, []);

  const last = props.samples?.[props.samples.length - 1];
  return (
    <div ref={wrap} className={`lc-plot lc-${size}${props.className ? ` ${props.className}` : ""}`}>
      <canvas ref={canvas} role="img" aria-label={props.label ?? (last ? `Live chart, now ${(props.fmt ?? String)(last[1])}` : "Live chart, waiting for prices")} />
    </div>
  );
}
