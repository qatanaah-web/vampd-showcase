// ── Vamp'd showcase ── In the product: web/lib/engine.ts — EXCERPTS (the full engine is ~840 lines).
// Kept: round phases, the coin floor, opening odds, settlement, the spike guard, lock/settle of two-phase rounds, placing a pick. Scanner I/O, stories, players and persistence are left out, so this file does not compile on its own.

// Market engine: opens memecoin markets from the scanner's live data, tracks prices, resolves and pays out.
// Runs inside the Next.js server process (started from instrumentation.ts).
//
// Price rounds, in two phases (pick, then live). Picks are open until the lock; the line is the average price at
// the lock, so nobody picks with the round already under way. The round settles on the average price over its last
// seconds, never on one tick. An exact tie or a dead price feed refunds everyone.
//   flash    — 60 s of picks, then 60 s live, back to back on the busiest fresh coins
//   fast     — 5 minutes live          battle — two coins, 5 minutes live: which gains more (in %)?
//   updown   — 15 minutes live on a fresh graduate; 60 minutes live on an established coin (tier "est")
// Event markets. Picks are open for the first half of the window; Yes settles the moment the event happens.
//   double   — 60 min: will $COIN touch a round market cap ($150K, $500K...) before the close?
//   launch   — 10 min: will a just-launched coin reach N SOL on its bonding curve? (read from the chain)
//   graduate — 10-60 min: will this final-stretch coin graduate before the close?
//   grads    — 60 min: graduations this hour over/under N? (scanner graduation counter)
//   story    — 10-30 min: one narrative from the scanner's radar (a coin graduates, the leader holds #1, #1 vs #2,
//              N+ new copies). "#1" questions settle on market caps read at the close.
// Retired 2026-11-12 (could not be made a fair bet): million ("a new $1M coin": 1-36% Yes on every line under the
// floor), story "first" (the original stays #1: 76-99% Yes) and story "run" (a twin of launch on a minute-old
// reading: 68% Yes against a 41% estimate).
// Coins: a price market only opens on a coin that passes FLOOR (lib/calibration.json was built on the same floor).
// Balance (lib/calibration.ts): every line is picked so the chance of Yes, corrected by how the kind and the bucket
// actually settled, is as close to 50% as it gets and inside 35-65%; the house seed is split by that chance.
// Settled markets are logged to data/resolved.jsonl; scripts/fairness.mjs checks the log against these targets.
// Pool odds (parimutuel): the winning side splits the whole pool, minus a 2% fee, and never gets back less than it
// put in; each side starts with a small house seed so odds exist before the first pick.
// Prices refresh every 2.5-5 s (live ticks in between); market opening and scanner reads run every 20 s.

import { payoutOf, twap } from "./fair";
import { cutoff, decided } from "./decided";
import type { Market, Side } from "./types";
// (store, live-feed, scanner and calibration imports omitted)

export const FEE = 0.02, START_BALANCE = 1000, SEED = 100, DAILY_BONUS = 250;
const PRICED = new Set(["flash", "fast", "updown", "double", "battle"]);
const LIVE_KINDS = new Set<Market["kind"]>(["flash", "fast", "battle"]);
const MIN = 60_000;
/** Two-phase price rounds. live: how long the round runs after the lock. pick: the shortest pick phase (the round
 *  closes on the next `step`-minute mark that leaves at least that). lockMs / closeMs: the line and the settle price
 *  are the time-weighted average price over this long before the lock / the close (Polymarket moved its 5- and
 *  15-minute crypto rounds from one snapshot to a 30-60 s average in 2026-08; Kalshi averages 60 s at both ends). */
const ROUND = {
  flash: { live: MIN, pick: 50_000, step: 0, lockMs: 5_000, closeMs: 10_000 },
  fast: { live: 5 * MIN, pick: 90_000, step: 5, lockMs: 10_000, closeMs: 30_000 },
  battle: { live: 5 * MIN, pick: 90_000, step: 5, lockMs: 10_000, closeMs: 30_000 },
  updown: { live: 15 * MIN, pick: 3 * MIN, step: 5, lockMs: 15_000, closeMs: 60_000 },
  est: { live: 60 * MIN, pick: 8 * MIN, step: 15, lockMs: 30_000, closeMs: 60_000 },
};
const phases = (k: keyof typeof ROUND, now: number) => {
  const r = ROUND[k], lockAt = k === "flash" ? Math.ceil((now + r.pick) / 10_000) * 10_000 : nextMark(now, r.pick + r.live, r.step) - r.live;
  return { opensAt: now, lockAt, closesAt: lockAt + r.live, lockMs: r.lockMs, closeMs: r.closeMs };
};

/** Floors for price markets (flash, fast, updown, double, battle) on fresh graduates, in one place. A crash is a
 *  fair outcome; what a small coin makes cheap is moving the price a market settles on, so price markets only open
 *  on coins with depth: graduated to a pool, this much liquidity and market cap, this many trades in 5 minutes.
 *  avgTrade: the average trade over the last 5 minutes, in dollars. A volume bot fills a pool with thousands of $1-2
 *  trades that walk the price up a little every minute until the pool is pulled. In 12 days of scanner history
 *  (32,530 coin-moments passing the other floors) the coins under $20 a trade closed Up in 76% of 1-minute and 72%
 *  of 5-minute rounds and 56% of them collapsed within the hour; the coins above it closed Up 51% / 52% and 17%
 *  collapsed (lib/calibration.json "wash"; re-check with scripts/floor_replay.mjs).
 *  Coins still on the bonding curve only get event markets (reach N SOL, graduate, stories), where a crash is a No.
 *  rugLiq / rugKeep: liquidity under this, or under this share of what the market first saw, flags "liquidity pulled".
 *  oneWay: a coin whose last 5+ rounds (two hours) closed the same way this often gets no new price market (after
 *  the trade-size floor four coins still went 33 for 33 Up; waiting for 10 rounds let each run 6-14 rounds). */
export const FLOOR = { mcap: 100_000, liq: 20_000, tx5m: 20, vol5m: 500, avgTrade: 20, dump5m: -40, flashVol5m: 3_000, rugLiq: 3_000, rugKeep: 0.2, oneWay: 0.85 };
export const passesFloor = (p: Pick<DexQuote, "mcap" | "liquidity" | "vol5m" | "tx5m" | "change5m" | "dexId">) =>
  p.dexId !== "pumpfun" && p.mcap >= FLOOR.mcap && p.mcap < 50_000_000 && p.liquidity >= FLOOR.liq && p.liquidity / p.mcap >= 0.02 && (p.tx5m ?? 0) >= FLOOR.tx5m && p.vol5m > FLOOR.vol5m && p.vol5m / (p.tx5m || 1) >= FLOOR.avgTrade && (p.change5m ?? 0) > FLOOR.dump5m;

// ----- opening a market: fair opening odds -----
function open(m: Omit<Market, "id" | "pool" | "seed" | "status" | "samples"> & { samples?: [number, number][] }, est: Line) {
  const id = newId("m"), now = m.opensAt;
  // Start from the live pool price when the coin is already on the live feed (DexScreener lags it).
  const lp = m.coin && PRICED.has(m.kind) ? livePrice(m.coin.mint) : undefined, lp2 = m.coin2 ? livePrice(m.coin2.mint) : undefined;
  if (lp && m.current) {
    if (m.kind === "double") { const r = lp / m.current; m.mcap = m.mcap && m.mcap * r; if (m.cap && m.mcap) m.mult = Math.round((m.cap / m.mcap) * 100) / 100; m.target = lp * (m.cap && m.mcap ? m.cap / m.mcap : m.mult ?? 2); }
    else m.target = lp;
    m.current = lp; m.samples = [[now, lp]];
  }
  if (lp2 && m.kind === "battle") { m.target2 = lp2; m.current2 = lp2; m.samples2 = [[now, lp2]]; }
  // Fair opening odds: the house seed is split by the chance of Yes for this line (the table's value corrected by
  // how the kind and the bucket have settled), so a 40% outcome opens paying about 2.4x, not 2x.
  const p = Math.min(BAND[1], Math.max(BAND[0], est.p)), seedYes = Math.round(2 * SEED * p);
  const sealed = SEALABLE.has(m.kind) && Math.random() < SEALED_SHARE ? true : undefined;
  db().markets[id] = { ...m, id, v: rulesOf(statKey(m)), opening: m.samples?.[0]?.[1] ?? m.current, samples: m.samples || [], pool: { yes: seedYes, no: 2 * SEED - seedYes }, seed: SEED, seedYes: seedYes === SEED ? undefined : seedYes, status: "open",
    p: Math.round(p * 1000) / 1000, p0: Math.round((est.p0 ?? est.p) * 1000) / 1000, calib: est.key, sealed, result: undefined, resolvedAt: undefined };
  save(); pushChanged();
  return id;
}

export const STREAK_BONUS_AT = 3;
/** Wins in a row from a player's settled picks (newest first; refunds skipped). */
export function streakOf(playerId: string, exclude?: string) {
  const d = db();
  const settled = d.bets.filter(b => b.player === playerId && b.market !== exclude && d.markets[b.market]?.status === "resolved")
    .sort((a, b) => (d.markets[b.market].resolvedAt ?? 0) - (d.markets[a.market].resolvedAt ?? 0));
  let n = 0; for (const b of settled) { if (b.payout) n++; else break; }
  return n;
}

/** Pays the winning side from the whole pool (minus FEE); the house seed's share is not paid out. */
function settle(m: Market, result: Side | "void") {
  if (m.status !== "open") return;
  const d = db(), bets = d.bets.filter(b => b.market === m.id);
  m.resolvedAt = Date.now();
  if (result === "void") {
    m.status = "void";
    for (const b of bets) { b.payout = b.amount; if (d.players[b.player]) d.players[b.player].balance += b.amount; }
  } else {
    m.status = "resolved"; m.result = result;
    const total = m.pool.yes + m.pool.no, win = m.pool[result];
    const streaks = new Map<string, number>();
    for (const b of bets) {
      b.payout = b.side === result ? payoutOf(b.amount, win, total, FEE) : 0;
      // Streak bonus: a win while already on 3+ wins in a row pays the house's extra 10%.
      if (b.payout) {
        if (!streaks.has(b.player)) streaks.set(b.player, streakOf(b.player, m.id));
        if (streaks.get(b.player)! >= STREAK_BONUS_AT) { b.bonus = Math.max(1, Math.floor(b.payout * 0.1)); b.payout += b.bonus; }
      }
      if (b.payout && d.players[b.player]) d.players[b.player].balance += b.payout;
    }
  }
  logResolved(m, bets);
  save(); pushChanged();
}

// ----- prices: live ticks (Solana websocket, lib/live.ts) with DexScreener as the fallback -----
/** A jump waiting for a second opinion: its price, when it came, and the timer that lets it through. */
const spikes = new Map<string, { p: number; t: number; timer?: NodeJS.Timeout }>();
/** How far one tick may move the series before it has to be confirmed: 3% on the live feed (ticks come every second
 *  or faster, so a real move is confirmed at once), 50% on the DexScreener poll. */
const JUMP = { live: 0.03, poll: 0.5 };
/** Settled at the price at the close: these kinds stop taking prices once the close passes. */
const AT_CLOSE = new Set<Market["kind"]>(["flash", "fast", "updown", "battle"]);

/** One new price for one side of a market (k = 1: coin, 2: coin2). A single tick more than 3% (live) or 50% (poll)
 *  away from the last price is held until the next tick confirms it, so a glitch can neither spike the chart nor
 *  settle a round. While a two-phase round is still taking picks, its line follows the price. */
function applyPrice(m: Market, k: 1 | 2, priceUsd: number, mcap: number | undefined, now: number, fromLive = false, force = false): boolean {
  if (m.status !== "open" || !(priceUsd > 0)) return false;
  if (AT_CLOSE.has(m.kind) && now >= m.closesAt) return false;
  const samples = k === 1 ? m.samples : (m.samples2 ||= []), key = k === 1 ? m.id : `${m.id}:2`;
  // A single tick that leaps away and is undone by the next one (a sandwiched trade, a glitch) must not reach the
  // chart or settle a round. A jump is held until the next tick agrees with it (then it is real and goes in) or
  // 4 s pass with nothing against it (a pool price stays where the last trade left it). A tick that comes back to
  // the old level simply replaces the held one, which is dropped.
  const last = samples.at(-1)?.[1] ?? (k === 1 ? m.current : m.current2), held = spikes.get(key), lim = fromLive ? JUMP.live : JUMP.poll;
  if (held?.timer) clearTimeout(held.timer);
  if (!force && last && Math.abs(priceUsd / last - 1) > lim && !(held && Math.abs(priceUsd / held.p - 1) < lim / 2)) {
    const timer = fromLive ? setTimeout(() => { const h = spikes.get(key); if (h && h.p === priceUsd) { spikes.delete(key); if (applyPrice(m, k, priceUsd, mcap, Date.now(), fromLive, true)) save(); } }, 4000) : undefined;
    spikes.set(key, { p: priceUsd, t: now, timer }); return false;
  }
  spikes.delete(key);
  const coin = k === 1 ? m.coin : m.coin2;
  if (coin && mcap) coin.mcap = mcap;
  if (k === 1) m.current = priceUsd; else m.current2 = priceUsd;
  // Chart samples: at most ~300 per market over its whole window (1 s apart for the short rounds).
  const step = Math.max(1000, (m.closesAt - m.opensAt) / 300);
  const lastT = samples.at(-1)?.[0] ?? 0;
  // A price never rewrites a sample across the lock or into an averaging window: the line and the settle price are
  // averages over exact stretches of time, so each sample must carry the time it was really the price.
  const edge = m.lockAt ? [m.lockAt - (m.lockMs ?? 0), m.lockAt, m.closesAt - (m.closeMs ?? 0)].some(b => lastT < b && now >= b) || now >= m.closesAt - (m.closeMs ?? 0) || (now >= m.lockAt - (m.lockMs ?? 0) && now < m.lockAt) : false;
  if (now - lastT >= step || samples.length === 1 || (edge && now - lastT >= 1000)) { samples.push([now, priceUsd]); if (samples.length > 400) samples.splice(1, 1); }
  else samples[samples.length - 1] = [lastT, priceUsd];
  const follow = !!m.lockAt && !m.locked && now < m.lockAt;
  if (follow) { if (k === 1) m.target = priceUsd; else m.target2 = priceUsd; }
  if (m.kind === "double" && k === 1 && m.mcap && mcap && mcap >= (m.cap ?? (m.mult ?? 2) * m.mcap) && (m.coin?.liquidity ?? 0) >= 10_000 && (m.coin!.liquidity! / mcap) >= 0.02) settle(m, "yes");
  pushDiff(k === 1 ? { id: m.id, c: priceUsd, mc: coin?.mcap, t: now, ...(follow ? { tg: priceUsd } : {}) } : { id: m.id, c2: priceUsd, t: now, ...(follow ? { tg2: priceUsd } : {}) });
  return true;
}

/** Markets that follow one coin's bonding curve: new launches and the final stretch. */

// ----- two-phase price rounds: lock, settle, and the flash series -----
/** The line of a round whose pick phase just ended: the average price over the last lockMs. A round whose coin had
 *  its liquidity pulled or collapsed while picks were open never starts (refund). */
function lockRounds(now: number) {
  for (const m of Object.values(db().markets)) {
    if (m.status !== "open" || !m.lockAt || m.locked || now < m.lockAt) continue;
    const line = twap(m.samples, m.lockAt - (m.lockMs ?? 5_000), m.lockAt) ?? m.current, line2 = m.coin2 ? twap(m.samples2, m.lockAt - (m.lockMs ?? 5_000), m.lockAt) ?? m.current2 : undefined;
    const lastT = Math.min(m.samples.at(-1)?.[0] ?? 0, m.coin2 ? m.samples2?.at(-1)?.[0] ?? 0 : Infinity);
    if (!line || (m.coin2 && !line2) || m.halt || m.bot === "dust" || m.lockAt - lastT > 30_000) { settle(m, "void"); continue; }
    m.target = line; m.opening = line; m.locked = true; if (m.coin?.mcap) m.mcap = m.coin.mcap;
    if (m.coin2) m.target2 = line2;
    pushDiff({ id: m.id, tg: line, ...(line2 ? { tg2: line2 } : {}), t: now });
    save(); pushChanged();
  }
}
/** Up, Down or refund for one side's series: the average over the last closeMs against the line. */
function roundEnd(m: Market, k: 1 | 2) {
  const s = k === 1 ? m.samples : m.samples2, line = k === 1 ? m.target : m.target2;
  const end = twap(s, m.closesAt - (m.closeMs ?? 8_000), m.closesAt) ?? (k === 1 ? m.current : m.current2);
  // Dead feed: no price in the last quarter of the live phase (20 s at least, 2 minutes at most: a server that
  // slept through the close must refund, not settle an hour on a price from 14 minutes before the bell).
  const lastT = s?.at(-1)?.[0] ?? 0, stale = m.closesAt - lastT > Math.max(20_000, Math.min(120_000, (m.closesAt - (m.lockAt ?? m.opensAt)) / 4));
  return { end, line, stale };
}
export function battleResult(m: Market): Side | "void" {
  if (!m.current || !m.target || !m.current2 || !m.target2) return "void";
  const a = m.current / m.target, b = m.current2 / m.target2;
  return a === b ? "void" : a > b ? "yes" : "no";
}
function settleRounds(now: number) {
  for (const m of Object.values(db().markets)) {
    if (m.status !== "open" || !AT_CLOSE.has(m.kind) || now < m.closesAt) continue;
    if (m.lockAt && !m.locked) { settle(m, "void"); continue; }
    const a = roundEnd(m, 1); if (a.end) m.current = a.end;
    if (m.kind === "battle") {
      const b = roundEnd(m, 2); if (b.end) m.current2 = b.end;
      settle(m, a.stale || b.stale ? "void" : battleResult(m));
    } else {
      // A dead feed still settles when the outcome is not in doubt (2% or more from the line, or liquidity was
      // pulled: a rug is Down); otherwise the round is refunded. An exact tie is refunded.
      const clear = !!m.current && !!m.target && (Math.abs(m.current / m.target - 1) >= 0.02 || m.halt === "liquidity");
      settle(m, !m.current || !m.target || (a.stale && !clear) || m.current === m.target ? "void" : m.current > m.target ? "yes" : "no");
    }
  }
}
const flashText = (lockAt: number) => `1-minute round. Picks are open until the line locks at ${new Date(lockAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/New_York" })} ET; the line is the average price over the 5 seconds before that. Up wins if the average price over the last 10 seconds of the minute is above the line. An exact tie is refunded.`;
/** Flash rounds run back to back on each of the busiest coins: the next round opens for picks the moment the last
 *  one locks, so a coin always has one round taking picks and one live. Runs on the 2.5 s loop. */
function openFlash(now: number) {
  const f = g.__nmFlash; if (!f || now - f.t > 60_000) return;
  const picking = new Set(openOf("flash").filter(m => m.lockAt && now < m.lockAt).map(m => m.coin!.mint));
  for (const { c, p } of f.list.slice(0, MAX.flash)) {
    if (picking.has(c.mint) || tooQuiet(c.mint, now)) continue; // two refunds in a row: the price is not moving
    const ph = phases("flash", now), sym = p.sym || c.sym;
    open({ kind: "flash", question: `${sym} up or down over 60 seconds?`, detail: flashText(ph.lockAt), yesLabel: "Up", noLabel: "Down", coin: coinOf(c, p), ...ph, target: p.priceUsd, current: p.priceUsd, mcap: p.mcap,
      samples: [[now, p.priceUsd]], source: "Live on-chain price of the coin's main pool (DexScreener as backup)" }, upLine(1, p.change5m));
    picking.add(c.mint);
  }
}
async function roundTick() {
  const now = Date.now();
  lockRounds(now); settleRounds(now); openFlash(now);
}


// ----- placing a pick (called by the API route, behind lib/guard.ts) -----
export function placeBet(playerId: string, marketId: string, side: Side, amount: number) {
  const d = db(), p = own(d.players, playerId), m = own(d.markets, marketId);
  if (!p) return { error: "Player not found. Reload the page to start a new account." };
  if (!m || m.status !== "open" || Date.now() >= m.closesAt - cutoff(m)) return { error: "This market has closed for new picks." };
  const early = decided(m, Date.now());
  if (early) return { error: `Picks closed early: ${early}.` };
  if (!Number.isFinite(amount) || amount < 1 || Math.floor(amount) !== amount) return { error: "Pick a whole number of points." };
  if (amount > p.balance) return { error: `You have ${p.balance} points.` };
  p.balance -= amount; m.pool[side] += amount;
  const bet = { id: newId("b"), player: p.id, market: m.id, side, amount, at: Date.now(), mint: m.coin?.mint, sym: m.coin?.sym };
  d.bets.push(bet); save();
  // A sealed market's live update and reply carry the total only (split evenly), never the sides.
  pushDiff({ id: m.id, pool: { ...pub(m).pool }, t: bet.at });
  return { bet, balance: p.balance, market: pub(m) };
}

