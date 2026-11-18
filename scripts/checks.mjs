// Checks of the arithmetic markets rest on. No server, no network:   node scripts/checks.mjs
// (Node 22.18+ runs the .ts files directly.) Exits 1 on the first failed group.
import { twap, payoutOf, correct, wilson } from "../src/engine/fair.ts";
import { curveOf } from "../src/engine/curve.ts";
import { cutoff, decided } from "../src/engine/decided.ts";

let failed = 0;
const ok = (name, cond, got) => { if (!cond) failed++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : `  (got ${JSON.stringify(got)})`}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ----- settle price: time-weighted average -----
ok("twap: flat series", near(twap([[0, 5], [1000, 5]], 0, 2000), 5));
ok("twap: weights by time held", near(twap([[0, 10], [9000, 20]], 0, 10_000), 11), twap([[0, 10], [9000, 20]], 0, 10_000));
ok("twap: last sample before the window carries in", near(twap([[0, 7]], 5000, 6000), 7));
ok("twap: one trade in the last 100 ms cannot move a 10 s window by more than 1% of its jump", Math.abs(twap([[0, 100], [9900, 200]], 0, 10_000) - 100) <= 1.0001, twap([[0, 100], [9900, 200]], 0, 10_000));
ok("twap: samples after the window are ignored", near(twap([[0, 1], [5000, 2], [20_000, 99]], 0, 10_000), 1.5));
ok("twap: nothing before the end is undefined", twap([[5000, 1]], 0, 1000) === undefined);
ok("twap: empty is undefined", twap([], 0, 1000) === undefined);

// ----- payout -----
{ const FEE = 0.02;
  ok("payout: lone pick of 10 on an even 100/100 seed pays 1.87x", payoutOf(10, 110, 210, FEE) === 18, payoutOf(10, 110, 210, FEE));
  ok("payout: a winner never gets back less than the stake", payoutOf(10_000, 10_100, 10_200, FEE) === 10_000, payoutOf(10_000, 10_100, 10_200, FEE));
  // Random pools: winners' payouts never exceed the whole pool, and a fair coin is never a winning bet on average.
  let worst = 0, ev = 0, n = 0, seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20_000; i++) {
    const p = 0.35 + 0.3 * rnd(), sy = Math.round(200 * p), sn = 200 - sy, by = Math.floor(rnd() * 2000), bn = Math.floor(rnd() * 2000), total = sy + sn + by + bn;
    const payY = by ? payoutOf(by, sy + by, total, FEE) : 0, payN = bn ? payoutOf(bn, sn + bn, total, FEE) : 0;
    worst = Math.max(worst, (payY - Math.max(by, by / (sy + by) * total)) , (payN - Math.max(bn, bn / (sn + bn) * total)));
    // a first pick of x on Yes at the seed's own chance p
    const x = 1 + Math.floor(rnd() * 200); ev += p * payoutOf(x, sy + x, 200 + x, FEE) / x; n++;
  }
  ok("payout: never more than the stake or the pool share, whichever is larger", worst <= 0, worst);
  ok("payout: a first pick at the seed's chance returns under 1.00 on average (no free side)", ev / n < 1, ev / n); }

// ----- correction of a table chance by results -----
ok("correct: no results, no change", near(correct(0.47, null, null), 0.47, 1e-6));
ok("correct: under 10 results, no change", near(correct(0.47, { n: 9, yes: 9, sumP0: 9 * 0.47 }, null), 0.47, 1e-6));
{ const c = correct(0.47, { n: 500, yes: 345, sumP0: 500 * 0.47 }, null); ok("correct: a kind that ran 69% on a 47% table is corrected to about 68%", c > 0.64 && c < 0.7, c); }
{ const c = correct(0.5, { n: 90, yes: 51, sumP0: 45 }, { n: 21, yes: 19, sumP0: 21 * 0.51 }); ok("correct: a hot bucket is corrected past its kind", c > 0.62, c); }
{ const c = correct(0.5, { n: 500, yes: 500, sumP0: 250 }, null); ok("correct: capped at 1.5 log-odds", c < 0.82, c); }
{ const [lo, hi] = wilson(50, 100); ok("wilson: 50 of 100 is about 40-60%", lo > 0.4 && lo < 0.41 && hi > 0.59 && hi < 0.6, [lo, hi]); }

// ----- bonding-curve address -----
ok("curve: derived address matches a create event seen by the scanner", curveOf("HabxNdkWUVtQyQqfft19YYVTHzSQqpqSTA6Ykffkpump") === "ys6PWjBaFWZ5DXh96rhcpYbNes7ET4vUahqvf1CRLxP", curveOf("HabxNdkWUVtQyQqfft19YYVTHzSQqpqSTA6Ykffkpump"));
ok("curve: junk is refused", curveOf("not a mint") === null);

// ----- pick windows -----
{ const t = 1_000_000_000, round = { kind: "fast", status: "open", opensAt: t, lockAt: t + 120_000, closesAt: t + 420_000, current: 2, target: 1, samples: [] };
  ok("two-phase round: picks close at the lock", cutoff(round) === 300_000, cutoff(round));
  ok("two-phase round: never 'decided' while picks are open", decided(round, t + 60_000) === null);
  const ev = { kind: "launch", status: "open", opensAt: t, closesAt: t + 600_000, current: 10, target: 20, opening: 10, samples: [[t, 10]] };
  ok("event market: picks close halfway", cutoff(ev) === 300_000, cutoff(ev));
  ok("event market: three quarters of the way to the target closes picks", !!decided({ ...ev, current: 18 }, t + 60_000));
  ok("event market: a dumped curve closes picks", !!decided({ ...ev, current: 3 }, t + 60_000)); }

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
