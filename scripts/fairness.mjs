// Fairness check over the settled-market log (data/resolved.jsonl). Works with the server stopped.
//   node scripts/fairness.mjs            every kind, current rules against the results before them
//   node scripts/fairness.mjs 24         current-rules results from the last 24 hours only
// A kind is fair when, under its current rules (lib/resolved.ts RULES):
//   - Yes wins 35-65% of the time. FAIL when the 95% interval lies wholly outside that band (needs 30+ results);
//     WARN when only the measured rate does.
//   - the chance the seed was split by is close to what happened (WARN beyond two standard errors and 8 points);
//   - refunds are rare (WARN over 20% with 20+ markets);
//   - an event market is not over before anyone can pick (WARN when over 30% of its Yes results came in the first
//     5% of the window);
//   - no coin's rounds close one way (WARN: a coin with 10+ rounds, 85%+ one side).
// Exits 1 when any kind FAILs.
import { readFileSync } from "node:fs";
import { rulesOf } from "../src/engine/resolved.ts";
import { wilson } from "../src/engine/fair.ts";

const hours = Number(process.argv[2]) || 0, since = hours ? Date.now() - hours * 3_600_000 : 0;
let rows = [];
try { rows = readFileSync(new URL("../data/resolved.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && !r.feedSwitch); }
catch { console.log("no data/resolved.jsonl yet"); process.exit(0); }
const BAND = [0.35, 0.65], pct = x => (x == null || Number.isNaN(x) ? "-" : `${Math.round(x * 100)}%`);
const TOUCH = new Set(["launch", "graduate", "double", "story:grad", "story:copies", "story:run"]);
const RETIRED = new Set(["million", "story:first", "story:run"]);
const side = rs => { const s = rs.filter(r => r.result !== "void"), y = s.filter(r => r.result === "yes").length; return { all: rs.length, n: s.length, y, rate: s.length ? y / s.length : null, void: rs.length - s.length }; };

let fails = 0;
console.log(`${rows.length} settled markets${hours ? `; current rules limited to the last ${hours} h` : ""}\n`);
console.log("kind            rules | before: n   yes | now:  n  yes   95% interval   seed est  refunds | verdict");
for (const key of [...new Set(rows.map(r => r.key))].sort()) {
  const k = rows.filter(r => r.key === key), v = rulesOf(key);
  const before = side(k.filter(r => (r.v ?? 1) < v)), nowRows = k.filter(r => (r.v ?? 1) === v && r.resolvedAt >= since), cur = side(nowRows);
  const s = nowRows.filter(r => r.result !== "void"), est = s.filter(r => r.p != null), e = est.length ? est.reduce((a, r) => a + r.p, 0) / est.length : null;
  const [lo, hi] = wilson(cur.y, cur.n), notes = [];
  let verdict = RETIRED.has(key) ? "retired" : cur.n < 30 ? "too few to judge" : "ok";
  if (!RETIRED.has(key) && cur.n >= 30) {
    if (hi < BAND[0] || lo > BAND[1]) { verdict = "FAIL"; fails++; notes.push("Yes rate outside 35-65%"); }
    else if (cur.rate < BAND[0] || cur.rate > BAND[1]) { verdict = "WARN"; notes.push("Yes rate outside 35-65% (interval still overlaps)"); }
    if (e != null) { const se = Math.sqrt((e * (1 - e)) / cur.n); if (Math.abs(cur.rate - e) > Math.max(0.08, 2 * se)) { if (verdict === "ok") verdict = "WARN"; notes.push(`seed estimate ${pct(e)} against ${pct(cur.rate)} realized`); } }
  }
  // A refund handed out more than 30 s after the moment it was due (the lock, or the close) means the server was not
  // running then (the host asleep, a restart): those say nothing about the market's rules and are listed apart.
  const asleep = nowRows.filter(r => r.result === "void" && r.resolvedAt - (r.lockAt && r.resolvedAt < r.closesAt ? r.lockAt : r.closesAt) > 30_000).length, own = cur.void - asleep;
  if (asleep) notes.push(`${asleep} more refunded with the server not running`);
  if (!RETIRED.has(key) && cur.all - asleep >= 20 && own / (cur.all - asleep) > 0.2) { if (verdict === "ok" || verdict === "too few to judge") verdict = "WARN"; notes.push(`${pct(own / (cur.all - asleep))} refunded`); }
  cur.void = own;
  if (TOUCH.has(key) && !RETIRED.has(key)) { const yes = s.filter(r => r.result === "yes"), quick = yes.filter(r => (r.resolvedAt - r.opensAt) / (r.closesAt - r.opensAt) < 0.05).length;
    if (yes.length >= 10 && quick / yes.length > 0.3) { if (verdict === "ok") verdict = "WARN"; notes.push(`${pct(quick / yes.length)} of Yes results came in the first 5% of the window`); } }
  console.log(key.padEnd(15), String(v).padStart(5), "|", String(before.n).padStart(10), pct(before.rate).padStart(5), "|", String(cur.n).padStart(7), pct(cur.rate).padStart(4), (cur.n ? `${pct(lo)}-${pct(hi)}` : "-").padStart(14), pct(e).padStart(10), String(cur.void).padStart(8), "|", verdict, notes.length ? `(${notes.join("; ")})` : "");
}

// Coins whose price rounds close one way (current rules only).
{ const by = new Map();
  for (const r of rows) { if (!r.mint || (r.kind !== "flash" && r.kind !== "fast") || r.result === "void" || (r.v ?? 1) !== rulesOf(r.key) || r.resolvedAt < since) continue; const x = by.get(r.mint) || by.set(r.mint, { n: 0, up: 0, q: r.question }).get(r.mint); x.n++; if (r.result === "yes") x.up++; }
  const lop = [...by.values()].filter(x => x.n >= 10 && Math.max(x.up, x.n - x.up) / x.n >= 0.85);
  console.log(`\nCoins with 10+ one-minute and five-minute rounds under the current rules: ${[...by.values()].filter(x => x.n >= 10).length}; closing one way 85%+ of the time: ${lop.length}`);
  for (const x of lop) console.log(`  WARN ${x.q.split(" ")[0]}: ${x.up} Up of ${x.n}`); }

// Price rounds: how far the settle price ended from the line (a line nobody could miss shows up as tiny moves).
{ const pr = rows.filter(r => ["flash", "fast", "updown"].includes(r.kind) && (r.v ?? 1) === rulesOf(r.key) && r.result !== "void" && r.end && r.line && r.resolvedAt >= since);
  for (const key of [...new Set(pr.map(r => r.key))].sort()) { const v = pr.filter(r => r.key === key).map(r => Math.abs(r.end / r.line - 1)).sort((a, b) => a - b);
    console.log(`${key}: median move from the line ${(v[v.length >> 1] * 100).toFixed(2)}% over ${v.length} rounds; under 0.1%: ${pct(v.filter(x => x < 0.001).length / v.length)}`); } }

// Supply: for every minute since the current rules began, how many markets of each family were taking picks
// (from the log, so markets still open are not counted: the last hour reads low).
{ const cur = rows.filter(r => (r.v ?? 1) === rulesOf(r.key) && rulesOf(r.key) > 1 && r.resolvedAt >= since); if (cur.length) {
  const fam = r => (r.tier === "est" ? "established coins (1 h)" : ["flash", "fast", "updown", "battle"].includes(r.kind) ? "fresh price rounds" : r.kind === "double" ? "cap milestones" : r.kind === "launch" || r.kind === "graduate" ? "curve (launch, final stretch)" : "other");
  const t0 = Math.min(...cur.map(r => r.opensAt)), t1 = Math.max(...cur.map(r => r.resolvedAt)) - 60 * 60_000, mins = Math.max(0, Math.floor((t1 - t0) / 60_000));
  if (mins >= 30) { console.log(`\nMarkets taking picks, minute by minute, over ${(mins / 60).toFixed(1)} h of the current rules (the last hour left out):`);
    for (const f of [...new Set(cur.map(fam))].sort()) { const rs = cur.filter(r => fam(r) === f), counts = [];
      for (let i = 0; i < mins; i++) { const t = t0 + i * 60_000; counts.push(rs.filter(r => r.opensAt <= t && t < Math.min(r.resolvedAt, r.lockAt ?? r.opensAt + (r.closesAt - r.opensAt) / 2)).length); }
      const s = [...counts].sort((a, b) => a - b); console.log(`  ${f.padEnd(30)} none ${pct(counts.filter(x => !x).length / mins).padStart(4)} of the time, median ${s[s.length >> 1]}`); } } } }

console.log(fails ? `\n${fails} kind(s) FAIL` : "\nno kind fails");
process.exit(fails ? 1 : 0);
