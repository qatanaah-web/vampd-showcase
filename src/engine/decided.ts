// ── Vamp'd showcase ── In the product: web/lib/decided.ts (shared by engine and UI).
// When picks close: two-phase lock, event-market half-window, and 'decided early' guards so no side is a free win.

import type { Market } from "./types";

/**
 * A price round whose coin has already halved or doubled against its line (or a battle where one coin is 50 points
 * ahead) is decided before the bell. Picks close early so nobody collects a free win. Shared by engine and client.
 */
/** Markets that follow one coin's bonding curve to a target (85 SOL = graduation). */
const curveKind = (m: Market) => m.kind === "launch" || m.kind === "graduate" || (m.kind === "story" && m.story?.sub === "run");
/** Markets that wait for an event (or read a state at the close with nothing live to judge it by). */
const waits = (m: Market) => m.kind === "launch" || m.kind === "graduate" || m.kind === "double" || m.kind === "million" || m.kind === "grads" || m.kind === "story";
/** Picks close this long before the end. Price rounds (flash, fast, updown, battle) have a pick phase and a live
 *  phase: picks close at lockAt, the moment the line is fixed, so nobody picks with the round already under way.
 *  Markets that wait for an event take picks for the first half of their window: each minute without the event
 *  makes No likelier, so a late No would be a free win against the house seed. Shared by engine and client. */
export const cutoff = (m: Market) => (m.lockAt ? m.closesAt - m.lockAt : m.kind === "flash" ? 10_000 : waits(m) ? Math.max(30_000, (m.closesAt - m.opensAt) / 2) : 30_000);

export function decided(m: Market, now = 0): string | null {
  if (m.status !== "open") return null;
  // Two-phase rounds: while picks are open the line still follows the price, so there is nothing to be ahead of.
  if (m.lockAt) return null;
  // A 30% lead is near-certain at any point of a 1-15 minute round; in the second half 15% already is
  // (2026-11-04: Up still paid 1.47x with the coin +23% and 3 minutes left).
  const late = !!now && m.closesAt - now < (m.closesAt - m.opensAt) / 2;
  const r = (c?: number, t?: number) => (c && t ? c / t : 1);
  const pct = (x: number) => `${Math.round(Math.abs(x - 1) * 100)}%`;
  if (m.kind === "flash" || m.kind === "fast" || m.kind === "updown") {
    const x = r(m.current, m.target);
    // In the last quarter an 8% gap is rarely closed either (5- and 15-minute rounds move ~5% in that time).
    const last = !!now && m.closesAt - now < (m.closesAt - m.opensAt) / 4;
    if (Math.abs(x - 1) >= 0.3 || (late && Math.abs(x - 1) >= 0.15) || (last && Math.abs(x - 1) >= 0.08)) return `$${m.coin?.sym ?? "coin"} ${x < 1 ? (x <= 0.5 ? "crashed" : "is down") : x >= 2 ? "ran" : "is up"} ${pct(x)} this round`;
  }
  if (m.kind === "battle") {
    const a = r(m.current, m.target), b = r(m.current2, m.target2);
    if (Math.abs(a - b) >= 0.5 || (late && Math.abs(a - b) >= 0.15)) return `$${(a > b ? m.coin : m.coin2)?.sym ?? "one coin"} is too far ahead to catch`;
  }
  // Doubling needs 2x from the open; a coin that has already lost 80% needs 10x from here (a rug, in practice).
  // Within 10% of the line, Yes is a near-free win against the house seed: close picks (it settles the moment it hits).
  // Lines sit close to the open now (1.15x, +3 SOL), so "almost there" is three quarters of the way from the open to
  // the line, not 90% of the line itself (which a +3 SOL line would meet at the open).
  if (m.kind === "double") { const o = m.opening ?? (m.target ? m.target / (m.mult ?? 2) : undefined), x = r(m.current, o);
    if (x <= 0.2) return `$${m.coin?.sym ?? "coin"} crashed ${pct(x)} since the open`;
    if (m.current && m.target && o && m.current >= o + 0.75 * (m.target - o)) return `$${m.coin?.sym ?? "coin"} is almost at its target`; }
  if (curveKind(m) && m.current != null && m.target) { const o = Math.min(m.opening ?? m.samples?.[0]?.[1] ?? 0, m.target - 1);
    if (m.current >= o + 0.75 * (m.target - o)) return `$${m.coin?.sym ?? "coin"} is almost there (${Math.round(m.current)} of ${m.target} SOL)`; }
  // Curve markets: a coin whose curve lost 60%+ of the SOL it had at the open was dumped (no way back in time).
  if (curveKind(m) && m.samples?.length && m.current != null) {
    const o = m.opening ?? m.samples[0][1]; if (o >= 3 && m.current <= 0.4 * o) return `$${m.coin?.sym ?? "coin"} was dumped (curve down ${Math.round((1 - m.current / o) * 100)}%)`;
  }
  if (m.kind === "grads" && m.current != null && m.target != null && m.current > m.target) return `Already ${m.current} graduations, past the line`;
  // Count markets (graduations, copies of a story): one short of the line is all but there.
  if (m.kind === "story" && m.story?.sub === "copies" && m.current != null && m.target != null && m.target >= 3 && m.current >= m.target - 1) return `Already ${m.current} of ${m.target} new coins`;
  // Out of time: in the last quarter of a round, a curve still under half its target or a graduation count under half
  // the pace it needs can't realistically get there, and No would be a free win against the house seed.
  const left = now ? (m.closesAt - now) / (m.closesAt - m.opensAt) : 1;
  if (left < 0.25 && (m.kind === "launch" || m.kind === "graduate") && m.current != null && m.target && m.current < 0.5 * m.target)
    return `Not enough time left: ${Math.round(m.current)} of ${m.target} SOL`;
  if (m.kind === "grads" && now && m.current != null && m.target != null) {
    const elapsed = 1 - left;
    if (elapsed >= 0.5 && m.current < 0.5 * m.target * elapsed) return `Only ${m.current} graduations so far, far behind the line`;
  }
  return null;
}
