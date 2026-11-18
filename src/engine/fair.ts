// ── Vamp'd showcase ── In the product: web/lib/fair.ts (server and client).
// Pure arithmetic the fairness of every market rests on: TWAP settle price, payout, calibration correction, Wilson interval.

// The arithmetic the fairness of a market rests on, with no imports, so scripts/checks.mjs can run it under plain
// Node: the settle price (time-weighted average), the payout, and the correction of a table chance by results.

/** Time-weighted average of a price series over [from, to]: each sample counts for as long as it was the price
 *  (the last sample before `from` carries in). Undefined when the series has nothing at or before `to`. */
export function twap(samples: [number, number][] | undefined, from: number, to: number): number | undefined {
  if (!samples?.length || to <= from) return undefined;
  let sum = 0, span = 0, cur: number | undefined, at = from;
  for (const [t, v] of samples) {
    if (t <= from) { cur = v; continue; }
    if (t > to) break;
    if (cur != null) { sum += cur * (t - at); span += t - at; }
    cur = v; at = t;
  }
  if (cur == null) return undefined;
  sum += cur * (to - at); span += to - at;
  return span > 0 ? sum / span : cur;
}

/** A winning pick's payout: its share of the whole pool after the fee, and never less than the stake (a big pick
 *  against a pool that holds little more than the seed would otherwise win and still lose points to the fee). */
export const payoutOf = (amount: number, winSide: number, total: number, fee: number) => Math.max(amount, Math.floor((amount / winSide) * total * (1 - fee)));

const lg = (x: number) => Math.log(x / (1 - x)), cl = (x: number) => Math.min(0.97, Math.max(0.03, x));
export type Stat = { n: number; yes: number; sumP0: number } | null;
/** How far results sit from the table, in log-odds, capped at +-1.5. */
const offset = (s: Stat) => (s && s.n ? Math.min(1.5, Math.max(-1.5, lg(cl((s.yes + 1) / (s.n + 2))) - lg(cl(s.sumP0 / s.n)))) : 0);
/** A table chance corrected by results. A kind's settled markets pull its estimates toward what happened from 10
 *  results on (weight n / (n + 30)); a bucket with 15+ results of its own is then pulled toward its own record
 *  (weight n / (n + 40)), so one bucket that runs hot (a huge story's "new copies") is not hidden inside a kind
 *  that is balanced on average. */
export function correct(p: number, kind: Stat, bucket: Stat) {
  const wk = kind && kind.n >= 10 ? kind.n / (kind.n + 30) : 0, wb = bucket && bucket.n >= 15 ? bucket.n / (bucket.n + 40) : 0;
  const off = wb * offset(bucket) + (1 - wb) * wk * offset(kind);
  return 1 / (1 + Math.exp(-(lg(cl(p)) + off)));
}

/** 95% Wilson interval for a share (yes of n). */
export function wilson(yes: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96, p = yes / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - w) / d, (c + w) / d];
}
