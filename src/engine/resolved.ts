// ── Vamp'd showcase ── In the product: web/lib/resolved.ts (server).
// Append-only settled-market log, rules versions per market kind, and the per-kind/per-bucket results the calibration correction reads.

// Append-only log of every settled market (data/resolved.jsonl) and the balance report built from it: per kind the
// Yes rate, how the estimated chance compared with what happened, and how lopsided players' picks were (sealed
// markets against open ones). The engine also reads it back to correct its estimates (lib/calibration.ts adjust()).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Bet, Market } from "./types";

const DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "data"), FILE = path.join(DIR, "resolved.jsonl");
export interface ResolvedRow {
  id: string; kind: string; /** kind, or "story:leader" etc. */ key: string; calib?: string; question: string;
  line?: number; mult?: number; minutes: number; /** estimate used for the seed / raw table value */ p?: number; p0?: number;
  result: "yes" | "no" | "void"; sealed: boolean; seedYes: number; pool: { yes: number; no: number };
  /** Where the coin traded, its market cap and liquidity at the open, and whether liquidity was pulled (from 2026-11-10 13:00). */
  venue?: string; mcap0?: number; liq0?: number; halt?: string;
  /** Settled while the price feed was being switched (2026-11-10, 11:44-11:52): kept in the log, left out of every statistic. */
  feedSwitch?: boolean;
  /** Rules version of this kind when the market opened (absent = 1; see RULES). The coin(s), and for price rounds
   *  the value it settled on against its line (from 2026-11-12). */
  v?: number; mint?: string; mint2?: string; end?: number; end2?: number; line2?: number; lockAt?: number; tier?: string;
  picks: { n: number; players: number; yes: number; no: number }; opensAt: number; closesAt: number; resolvedAt: number;
}
export const statKey = (m: Pick<Market, "kind" | "story" | "tier">) => (m.kind === "story" && m.story ? `story:${m.story.sub}` : m.tier ? `${m.kind}:${m.tier}` : m.kind);
/** Rules version per kind. It goes up when a kind's coins, line or settlement change enough that its older results
 *  no longer describe it; the online correction and scripts/fairness.mjs then only count the current version.
 *  2 (2026-11-12): price rounds on the trade-size floor and with picks in the first half only; launch lines from the
 *  on-chain curve and at least a minute of pace away; story "#1" markets settled on market caps at the close. */
export const RULES: Record<string, number> = { flash: 2, fast: 2, updown: 2, "updown:est": 2, battle: 2, "battle:est": 2, double: 2, launch: 2, "story:leader": 2, "story:duel": 2 };
export const rulesOf = (key: string) => RULES[key] ?? 1;

const g = globalThis as unknown as { __nmResolved?: ResolvedRow[] };
function rows(): ResolvedRow[] {
  if (g.__nmResolved) return g.__nmResolved;
  const out: ResolvedRow[] = [];
  try { if (existsSync(FILE)) for (const l of readFileSync(FILE, "utf8").split("\n")) if (l) try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ } } catch { /* no log yet */ }
  return (g.__nmResolved = out);
}

export function logResolved(m: Market, bets: Bet[]) {
  const side = (s: "yes" | "no") => bets.filter(b => b.side === s).reduce((a, b) => a + b.amount, 0);
  const r: ResolvedRow = { id: m.id, kind: m.kind, key: statKey(m), calib: m.calib, question: m.question, line: m.target, mult: m.mult, minutes: Math.round((m.closesAt - m.opensAt) / 60_000),
    p: m.p, p0: m.p0, venue: m.coin?.venue, mcap0: m.mcap, liq0: m.liq0, halt: m.halt, v: m.v, lockAt: m.lockAt, tier: m.tier, mint: m.coin?.mint, mint2: m.coin2?.mint, end: m.current, end2: m.current2, line2: m.target2, result: m.status === "void" ? "void" : m.result!, sealed: !!m.sealed, seedYes: m.seedYes ?? m.seed, pool: { ...m.pool },
    picks: { n: bets.length, players: new Set(bets.map(b => b.player)).size, yes: side("yes"), no: side("no") }, opensAt: m.opensAt, closesAt: m.closesAt, resolvedAt: m.resolvedAt ?? Date.now() };
  rows().push(r);
  try { mkdirSync(DIR, { recursive: true }); appendFileSync(FILE, JSON.stringify(r) + "\n"); } catch { /* the log is best effort; the market still settles */ }
}

const tally = (r: ResolvedRow[]) => (r.length ? { n: r.length, yes: r.filter(x => x.result === "yes").length, sumP0: r.reduce((a, x) => a + x.p0!, 0) } : null);
const counted = (x: ResolvedRow) => x.result !== "void" && x.p0 != null && !x.feedSwitch && (x.v ?? 1) === rulesOf(x.key);
/** Last 500 settled (not refunded) markets of a kind under its current rules that opened with an estimate. */
export const kindStats = (key: string) => tally(rows().filter(x => x.key === key && counted(x)).slice(-500));
/** The same for one calibration bucket ("story.copies:l3|*"), last 300. */
export const bucketStats = (calib: string) => tally(rows().filter(x => x.calib === calib && counted(x)).slice(-300));
/** A coin's last price rounds (1- and 5-minute, not refunded) within the window: how many, and how many closed Up. */
export function coinRounds(mint: string, sinceMs: number) {
  const r = rows().filter(x => x.mint === mint && (x.kind === "flash" || x.kind === "fast") && x.result !== "void" && x.resolvedAt >= sinceMs).slice(-14);
  return { n: r.length, up: r.filter(x => x.result === "yes").length };
}
/** Were this coin's last two 1-minute rounds (within 10 minutes) both refunded? Then it is too quiet for them. */
export function tooQuiet(mint: string, now: number) {
  const r = rows().filter(x => x.mint === mint && x.kind === "flash" && now - x.resolvedAt < 10 * 60_000).slice(-2);
  return r.length === 2 && r.every(x => x.result === "void");
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** Pick imbalance over markets with picks: the share of picked points that sat on the heavier side (0.5 = even). */
function imbalance(rs: ResolvedRow[]) {
  const w = rs.filter(x => x.picks.n > 0); if (!w.length) return { markets: 0 };
  const heavy = w.reduce((a, x) => a + Math.max(x.picks.yes, x.picks.no) / (x.picks.yes + x.picks.no), 0) / w.length;
  return { markets: w.length, picks: w.reduce((a, x) => a + x.picks.n, 0), heavySideShare: r3(heavy), oneSided: w.filter(x => !x.picks.yes || !x.picks.no).length };
}
/** When the floors for price markets went in (2026-11-10 12:52 PST); the report compares price markets on each side. */
export const FLOORS_SINCE = Date.parse("2026-11-10T20:52:00Z");
const PRICE_KINDS = new Set(["flash", "fast", "updown", "double", "battle"]);
function floorSide(rs: ResolvedRow[]) {
  const s = rs.filter(x => x.result !== "void"), hrs = rs.length ? (Math.max(...rs.map(x => x.resolvedAt)) - Math.min(...rs.map(x => x.opensAt))) / 3_600_000 : 0;
  return { markets: rs.length, perHour: hrs > 0.05 ? r3(rs.length / hrs) : null, refunded: rs.length - s.length, yesRate: s.length ? r3(s.filter(x => x.result === "yes").length / s.length) : null,
    liquidityPulled: rs.filter(x => x.halt === "liquidity").length };
}

export function balanceReport(sinceMs = 0) {
  const all = rows().filter(x => x.resolvedAt >= sinceMs && !x.feedSwitch), kinds: Record<string, unknown> = {};
  for (const key of [...new Set(all.map(x => x.key))].sort()) {
    const k = all.filter(x => x.key === key), s = k.filter(x => x.result !== "void"), e = s.filter(x => x.p != null);
    const bin = (lo: number, hi: number) => { const b = e.filter(x => x.p! >= lo && x.p! < hi); return b.length ? { n: b.length, estimated: r3(b.reduce((a, x) => a + x.p!, 0) / b.length), realized: r3(b.filter(x => x.result === "yes").length / b.length) } : undefined; };
    const cur = s.filter(x => (x.v ?? 1) === rulesOf(key));
    kinds[key] = { rules: rulesOf(key), currentRules: { settled: cur.length, yesRate: cur.length ? r3(cur.filter(x => x.result === "yes").length / cur.length) : null }, settled: s.length, refunded: k.length - s.length, yesRate: s.length ? r3(s.filter(x => x.result === "yes").length / s.length) : null,
      estimated: e.length ? r3(e.reduce((a, x) => a + x.p!, 0) / e.length) : null, table: e.length ? r3(e.reduce((a, x) => a + (x.p0 ?? x.p!), 0) / e.length) : null,
      brier: e.length ? r3(e.reduce((a, x) => a + (x.p! - (x.result === "yes" ? 1 : 0)) ** 2, 0) / e.length) : null,
      calibration: { under40: bin(0, 0.4), mid: bin(0.4, 0.6), over60: bin(0.6, 1.01) },
      picks: { all: imbalance(k), sealed: imbalance(k.filter(x => x.sealed)), open: imbalance(k.filter(x => !x.sealed)) } };
  }
  const price = rows().filter(x => PRICE_KINDS.has(x.kind) && !x.feedSwitch);
  const floors = { since: FLOORS_SINCE, before: floorSide(price.filter(x => x.opensAt < FLOORS_SINCE)), after: floorSide(price.filter(x => x.opensAt >= FLOORS_SINCE)) };
  return { since: sinceMs || null, markets: all.length, now: Date.now(), floors, sealedVsOpen: { sealed: imbalance(all.filter(x => x.sealed)), open: imbalance(all.filter(x => !x.sealed)) }, kinds };
}
