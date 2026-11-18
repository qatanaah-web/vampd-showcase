// ── Vamp'd showcase ── In the product: web/lib/question.ts (client).
// Market titles in plain words: relative/local time, the line named, settled markets say what happened.

// Market titles for display: name the target and use relative / local time, so "higher at 4:50 AM ET?" becomes
// "$ABDUL above $97.2K in 7 min?" (the engine's stored question stays as the fallback and for share images).
import type { Market } from "./types";
import { capOf, usd } from "./client";

/** A round cap in words: $150K, $1.25M. */
const capLabel = (n: number) => (n >= 1e9 ? `$${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : `$${+(n / 1e3).toFixed(1)}K`);
export const localClock =(t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function when(m: Market, now: number, word = "at") {
  if (m.status !== "open" || !now) return `${word} ${localClock(m.closesAt)}`;
  const sec = (m.closesAt - now) / 1000;
  if (sec < 60) return "in under a minute";
  const min = Math.round(sec / 60);
  return min < 60 ? `in ${min} min` : `${word} ${localClock(m.closesAt)}`;
}

/** short: cards already name the coin right above the title, so leave the ticker out there. */
export function title(m: Market, now: number, short = false) {
  if (m.status !== "open") return pastTitle(m);
  const sym = m.coin && !short ? `$${m.coin.sym} ` : "";
  const cap = (x: string) => (sym ? x : x.charAt(0).toUpperCase() + x.slice(1));
  // Two-phase rounds: before the lock the question names the stretch the round covers; after it, the line to beat.
  if (m.lockAt && now && now < m.lockAt) {
    const span = Math.round((m.closesAt - m.lockAt) / 60_000), over = span <= 1 ? "the next 60 seconds" : `${span} minutes`;
    if (m.kind === "battle" && m.coin2) return short ? `Who gains more over ${over}?` : `$${m.coin!.sym} vs $${m.coin2.sym}: who gains more over ${over}?`;
    // Say what it is measured against: the starting price, fixed the moment picks close.
    return cap(`${sym}up or down from its starting price over ${over}?`);
  }
  switch (m.kind) {
    case "flash": case "fast": { const t = capOf(m, m.target); return t ? cap(`${sym}up or down from ${usd(t)} ${when(m, now)}?`) : cap(`${sym}up or down from its starting price ${when(m, now)}?`); }
    case "updown": { const t = capOf(m, m.target); return t ? cap(`${sym}up or down from ${usd(t)} ${when(m, now)}?`) : m.question; }
    case "battle": return m.coin2 ? (short ? `Who gains more ${when(m, now)}?` : `$${m.coin!.sym} vs $${m.coin2.sym}: who gains more ${when(m, now)}?`) : m.question;
    case "graduate": return sym ? `Will ${sym}graduate ${when(m, now)}?` : `Graduates ${when(m, now)}?`;
    case "launch": return sym ? `Will ${sym}hit ${m.target} SOL on its curve ${when(m, now)}?` : `Hits ${m.target} SOL on its curve ${when(m, now)}?`;
    case "double": { const goal = m.cap ? capLabel(m.cap) : m.mcap ? usd((m.mult ?? 2) * m.mcap) : ""; return goal ? (sym ? `Will ${sym}hit ${goal} ${when(m, now, "by")}?` : `Hits ${goal} ${when(m, now, "by")}?`) : m.question; }
    default: return m.question.replace(/\b(at|by) (\d{1,2}:\d{2} [AP]M) ET\b/, (_, w) => when(m, now, w));
  }
}

/** Settled markets say what happened instead of asking. */
function pastTitle(m: Market) {
  const sym = m.coin ? `$${m.coin.sym}` : "", yes = m.result === "yes";
  if (m.status === "void") return `${sym ? `${sym} round` : "Market"} refunded`;
  switch (m.kind) {
    case "battle": return yes ? `${sym} beat $${m.coin2?.sym}` : `$${m.coin2?.sym} beat ${sym}`;
    case "flash": case "fast": case "updown": return `${sym} closed ${yes ? "up" : "down"} at ${localClock(m.closesAt)}`;
    case "launch": return `${sym} ${yes ? "reached" : "missed"} ${m.target} SOL`;
    case "graduate": return `${sym} ${yes ? "graduated" : "didn't graduate"}`;
    case "double": return m.cap ? `${sym} ${yes ? "hit" : "missed"} ${capLabel(m.cap)}` : m.mult && m.mult !== 2 && m.mcap ? `${sym} ${yes ? "hit" : "missed"} ${usd(m.mult * m.mcap)}` : `${sym} ${yes ? "doubled" : "didn't double"}`;
    case "million": { const L = (m.target ?? 1e6) >= 1e6 ? `$${(m.target ?? 1e6) / 1e6}M` : `$${Math.round((m.target ?? 0) / 1e3)}K`; return yes ? `A ${L} coin landed` : `No ${L} coin this time`; }
    case "story": { const s = m.story, name = `“${s?.label ?? "story"}”`;
      switch (s?.sub) {
        case "grad": return yes ? `A ${name} coin graduated` : `No new ${name} graduation`;
        case "leader": return `${sym} ${yes ? "held" : "lost"} #1 on ${name}`;
        case "first": return `The original ${sym} ${yes ? "stayed #1" : "was overtaken"}`;
        case "duel": return yes ? `${sym} stayed ahead of $${s.rival?.sym}` : `$${s.rival?.sym} passed ${sym}`;
        case "run": return `${sym} ${yes ? "reached" : "missed"} ${m.target} SOL`;
        case "copies": return `${name}: ${yes ? `${m.target}+` : `under ${m.target}`} new ${m.target === 1 ? "copy" : "copies"}`;
        default: return m.question;
      } }
    case "grads": return `${yes ? "Over" : "Under"} ${m.target} graduations`;
  }
}

/** For stored question strings without the market (e.g. pick history): swap the ET clock for local time. */
export const localizeQ = (q: string | undefined, closesAt?: number) =>
  q && closesAt ? q.replace(/\d{1,2}:\d{2} [AP]M ET\b/, localClock(closesAt)) : q;
