// ── Vamp'd showcase ── In the product: web/lib/calibration.ts (server).
// Line setting: choose the line whose results-corrected chance is closest to 50% and inside 35-65%. The table it reads (calibration.json) is not included.

// Balance: every market opens on a line whose chance of Yes is close to 50%, and the house seed is split by that
// chance, so no side is a free win. The table (lib/calibration.json) is built from the scanner's history by
// scripts/vampd_calib.mjs (runs offline on the research machine; not included) plus the hourly table for established coins
// (scripts/est_calib.js). Each lookup takes the table's chance for every candidate line, corrects it by how this
// kind of market (and this bucket of it) has actually settled (lib/resolved.ts), and returns the line closest to
// even. A market only opens when that corrected chance is inside BAND. scripts/fairness.mjs re-checks the result.
import table from "./calibration.json";
import { bucketStats, kindStats } from "./resolved";
import { correct } from "./fair";

type Row = { n: number; p: (number | null)[] };
type Tab = Record<string, Row>;
const C = table as unknown as {
  generated: string; edges: Record<string, number[]>; lines: Record<string, number[]>; storyEdges: Record<string, number[]>; storyLines: Record<string, number[]>;
  launch: Record<string, Tab>; graduate: Tab; up: Record<string, Tab>; double: Record<string, Tab>; grads: Tab;
  story: { grad: Tab; leader: Tab; duel: Tab; copies: Record<string, Tab> };
  est: { edges: number[]; n: number[]; p: number[] };
};
export const CALIBRATED_AT = C.generated;
/** A market opens only when its corrected chance of Yes is inside this band. */
export const BAND: [number, number] = [0.35, 0.65];
export const inBand = (p: number, band = BAND) => p >= band[0] && p <= band[1];
/** p: the chance used for the seed (table value corrected by results); p0: the raw table value; key: the bucket. */
export interface Line { p: number; p0?: number; key: string; target?: number; minutes?: number; mult?: number; cap?: number }

/** Index of the bucket v falls in (-1 below the first edge), same rule as the calibration script. */
const bk = (v: number, edges: number[]) => { let i = 0; while (i < edges.length && v >= edges[i]) i++; return i - 1; };
const MIN_N = 60;
/** The bucket's row, falling back to its parent ("r12|*") and then to all cases ("*") when it has too few cases. */
function row(t: Tab | undefined, key: string): [Row, string] | null {
  if (!t) return null;
  for (const k of [key, key.replace(/\|[^|]*$/, "|*"), "*"]) if (t[k]?.n >= MIN_N) return [t[k], k];
  return null;
}
/** P at column value x, linear between the two nearest columns (flat outside them). */
function at(r: Row, cols: number[], x: number): number | null {
  let lo = -1, hi = -1;
  cols.forEach((c, i) => { if (r.p[i] == null) return; if (c <= x) lo = i; else if (hi < 0) hi = i; });
  if (lo < 0 && hi < 0) return null; if (lo < 0) return r.p[hi]; if (hi < 0) return r.p[lo];
  return r.p[lo]! + ((r.p[hi]! - r.p[lo]!) * (x - cols[lo])) / (cols[hi] - cols[lo]);
}

/** statKey: the kind ("launch", "story:copies"); calib: the bucket key the line came from. */
export const adjust = (statKey: string, calib: string, p: number) => correct(p, kindStats(statKey), bucketStats(calib));

/** Candidate lines with raw table chances -> the one whose corrected chance is closest to even, inside the band. */
function best<T extends Line>(statKey: string, opts: T[], band = BAND): T | undefined {
  return opts.map(o => ({ ...o, p0: o.p, p: adjust(statKey, o.key, o.p) })).filter(o => inBand(o.p, band)).sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5))[0];
}

/** New launch at r0 SOL filling spm SOL a minute: the whole-SOL target it reaches within 10 minutes about half the
 *  time. The target is at least a minute of the current pace away (and 4 SOL): a line two seconds from being hit is
 *  not a question (most of the first version's launch markets were over within 20 seconds). */
export function launchLine(r0: number, spm: number): Line | undefined {
  const e = C.edges, got = row(C.launch["10"], `r${e.launchR[bk(r0, e.launchR)]}|s${bk(spm, e.launchS)}`); if (!got) return;
  const opts: Line[] = [];
  for (let t = Math.ceil(r0 + Math.max(4, spm)); t <= 84; t++) { const p = at(got[0], C.lines.deltas, t - r0); if (p != null) opts.push({ p, key: `launch:${got[1]}`, target: t, minutes: 10 }); }
  return best("launch", opts);
}
/** Final-stretch coin: the window (10-60 min) in which it graduates closest to half the time. */
export function graduateLine(r0: number, spm: number): Line | undefined {
  const e = C.edges, got = row(C.graduate, `r${e.gradR[bk(Math.min(r0, 84), e.gradR)]}|s${bk(spm, e.gradS)}`); if (!got) return;
  return best("graduate", C.lines.gradT.map((m, i) => ({ p: got[0].p[i] ?? -1, key: `graduate:${got[1]}`, minutes: m })).filter(o => o.minutes! >= 10));
}
/** Up/Down from the open on a freshly graduated coin: the chance of Up by the coin's last 5-minute move, from the
 *  table built on coins that pass the engine's floor. Kept within 45-55%: a price round is close to a coin flip by
 *  construction, and a seed further from even than that would itself be the free side. 1-minute rounds use the
 *  rate over all coins (51% Up): the history is 30-second polls, too coarse to split one minute by momentum. */
export function upLine(minutes: 1 | 5 | 15, chg5: number | undefined): Line {
  const kind = minutes === 1 ? "flash" : minutes === 5 ? "fast" : "updown";
  const got = minutes === 1 ? row(C.up["1"], "*") : row(C.up[String(minutes)], `c${bk(chg5 ?? 0, C.edges.chg)}|x`), p0 = got ? (minutes === 1 ? got[0].p[0] : at(got[0], C.lines.shifts, 0)) ?? 0.5 : 0.5, key = `up${minutes}:${got?.[1] ?? "none"}`;
  return { p: Math.min(0.55, Math.max(0.45, adjust(kind, key, p0))), p0, key };
}
/** Up/Down over the next hour on an established coin, by its move over the last hour (they revert a little: after a
 *  10%+ hour Up wins 35%, after a -5% hour 52%). */
export function estUpLine(chg1h: number | undefined): Line {
  const i = bk(chg1h ?? 0, C.est.edges) + 1, p0 = C.est.p[i] ?? 0.47, key = `est:c${i}`;
  return { p: Math.min(0.6, Math.max(0.4, adjust("updown:est", key, p0))), p0, key };
}
/** Market-cap milestone: a round cap ($150K, $500K, $1M...) the coin touches within 60 minutes about half the
 *  time, between 1.1x and 3x its cap now. */
const NICE = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5];
export function capLine(mcap: number, chg5: number | undefined): Line | undefined {
  const e = C.edges, got = row(C.double["60"], `m${e.mc[Math.max(0, bk(mcap, e.mc))]}|c${bk(chg5 ?? 0, e.chgD)}`); if (!got) return;
  const opts: Line[] = [], lo = Math.floor(Math.log10(mcap));
  for (const dec of [lo, lo + 1]) for (const k of NICE) { const cap = k * 10 ** dec, mult = cap / mcap; if (mult < 1.1 || mult > 3) continue;
    const p = at(got[0], C.lines.mults, mult); if (p != null) opts.push({ p, key: `double:${got[1]}`, mult, cap, minutes: 60 }); }
  return best("double", opts);
}
/** Graduations next hour, over/under: the line (a share of the last hour's count) that is beaten about half the time. */
export function gradsLine(prev: number): Line | undefined {
  const g = C.lines.gradsPrev, got = row(C.grads, `p${g[bk(prev, g)]}|x`); if (!got || prev < 3) return;
  const seen = new Set<number>();
  return best("grads", C.lines.ratios.map((q, i) => ({ p: got[0].p[i] ?? -1, key: `grads:${got[1]}`, target: Math.round(prev * q), minutes: 60 })).filter(o => o.target! >= 1 && !seen.has(o.target!) && !!seen.add(o.target!)));
}

// ----- stories (the radar's features at the open) -----
export interface StoryFeat { coins: number; grads: number; leaderR: number; leaderGrad: boolean; leaderIsFirst: boolean; lpm15: number; lpm5: number; leaderT: number; leaderMom5: number | null }
const S = C.storyEdges, ST = C.storyLines.T;
const rKey = (f: StoryFeat) => (f.leaderGrad ? "g" : `r${S.ldrR[bk(f.leaderR, S.ldrR)]}`);
const ageKey = (f: StoryFeat, now: number) => `a${S.age[Math.max(0, bk((now - f.leaderT) / 60_000, S.age))]}|l${S.lpm[bk(f.lpm15, S.lpm)]}`;
const overT = (t: Tab, key: string, tag: string) => { const got = row(t, key); return got ? best(tag.replace(".", ":"), ST.map((m, i) => ({ p: got[0].p[i] ?? -1, key: `${tag}:${got[1]}`, minutes: m }))) : undefined; };
export const storyGrad = (f: StoryFeat) => overT(C.story.grad, `${rKey(f)}|${f.grads >= 2 || f.coins >= 50 ? "hot" : "cool"}`, "story.grad");
export const storyLeader = (f: StoryFeat, now: number) => overT(C.story.leader, ageKey(f, now), "story.leader");
export const storyDuel = (f: StoryFeat) => overT(C.story.duel, `${rKey(f)}|l${S.lpm[bk(f.lpm15, S.lpm)]}`, "story.duel");
/** N+ new coins on the story within T minutes, N a share of the recent launch pace. */
export function storyCopies(f: StoryFeat): Line | undefined {
  if (f.lpm15 < 0.2) return;
  const opts: Line[] = [];
  for (const tm of ST) { const got = row(C.story.copies[String(tm)], `l${S.lpmC[bk(f.lpm15, S.lpmC)]}|${f.lpm5 >= f.lpm15 ? "up" : "dn"}`); if (!got) continue; const seen = new Set<number>();
    C.storyLines.q.forEach((q, i) => { const n = Math.max(1, Math.ceil(q * f.lpm15 * tm)); if (got[0].p[i] != null && !seen.has(n) && seen.add(n)) opts.push({ p: got[0].p[i]!, key: `story.copies:${got[1]}`, target: n, minutes: tm }); }); }
  return best("story:copies", opts);
}
