// ── Vamp'd showcase ── In the product: web/lib/types.ts.
// Shared data shapes for markets, picks and players.

// Shared shapes for markets, players and bets. Play money (points) only for now.

export type Side = "yes" | "no";

export type MarketKind =
  | "updown" //   Will $COIN be higher at the close than at the open?
  | "graduate" // Will this final-stretch coin graduate before the close?
  | "grads" //    Graduations this hour: over or under N?
  | "flash" //    1-minute Up/Down rounds on the hottest coin, back to back
  | "fast" //     5-minute Up/Down rounds on the hottest coin, back to back
  | "double" //   Will $COIN double its market cap before the close?
  | "million" //  Will any new coin reach a real $1M market cap before the close?
  | "launch" //   New launch: will a just-launched coin reach N SOL on its bonding curve before the close?
  | "battle"  //  Coin battle: which of two hot coins gains more (in %) by the close? yes = coin, no = coin2
  | "story"; //   Story market: one narrative from the scanner's radar (see Market.story.sub)

/** What a story market asks. grad: a coin of the story graduates before the close; leader: the top coin is still
 *  #1 by market cap at the close; first: the original coin is #1 at the close; duel: #1 stays ahead of #2 at the
 *  close; run: the top coin reaches N SOL on its curve before the close; copies: N+ new coins before the close. */
export type StorySub = "grad" | "leader" | "first" | "duel" | "run" | "copies";
export interface StoryRef {
  sid: string;
  sub: StorySub;
  /** Short readable name of the narrative ("Ring Cat"). */
  label: string;
  /** The post the story's coins link to, when the radar knows it. */
  post?: { user?: string; text?: string; url?: string };
  /** The story's first coin (identifies the story if the radar renames it). */
  first: string;
  /** grad: graduations at the open; copies: coins at the open. */
  base?: number;
  /** duel: the #2 coin. */
  rival?: { mint: string; name: string; sym: string };
  /** Last radar sighting after the open: when, who led, and (duel) the top coins in market-cap order. */
  seenAt?: number;
  top?: string;
  order?: string[];
}

/** Everything needed to know exactly which coin a market is about (thousands share similar names). */
export interface Coin {
  mint: string;
  name: string;
  sym: string;
  img?: string;
  mcap?: number;
  liquidity?: number;
  vol5m?: number;
  change5m?: number;
  /** Where it trades: still on the pump.fun bonding curve, or graduated to a pool. */
  venue?: "curve" | "pool";
  /** What the scanner says about how it launched: "bundled" (bought up in a bundle at launch), "copy" (a late copy of an existing coin). */
  flags?: string[];
  /** When its trading pool was created (ms). */
  createdAt?: number;
  pair?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  /** The post that started the narrative, when the coin links one. */
  narrative?: { user?: string; text?: string; url?: string };
}

export interface Market {
  /** Distinct players with a pick (list API only). */
  players?: number;
  id: string;
  kind: MarketKind;
  question: string;
  /** Plain-English line under the question. */
  detail: string;
  yesLabel: string; // "Up", "Yes", "Over"
  noLabel: string; //  "Down", "No", "Under"
  coin?: Coin;
  opensAt: number;
  closesAt: number;
  /** updown: price at the open; grads: the line N. */
  target?: number;
  /** updown: latest price; grads: graduations counted so far this window. */
  current?: number;
  /** Recent samples for the sparkline: [time ms, value]. */
  samples: [number, number][];
  /** The value at the open (samples get trimmed for the client, so rules that compare with the open use this). */
  opening?: number;
  /** Pool in points, including the house seed. */
  pool: { yes: number; no: number };
  /** House seed per side on average (the seed total is 2 * seed). */
  seed: number;
  /** House seed on Yes when the split is not even (odds start at the kind's recent hit rate). */
  seedYes?: number;
  status: "open" | "resolved" | "void";
  /** Priced by the live feed since its open (target set from a live price). */
  liveBased?: boolean;
  liveBased2?: boolean;
  result?: Side;
  resolvedAt?: number;
  /** Market cap at the open (updown/fast/double), for display. */
  mcap?: number;
  /** Story markets: the story's coins (market-cap order at the open, later arrivals added), ranked by market cap at
   *  the close. (million, retired: the coins watched for the cap.) */
  watch?: string[];
  /** battle: the second coin, its price at the open, latest price and samples. */
  coin2?: Coin;
  target2?: number;
  current2?: number;
  samples2?: [number, number][];
  /** Hue (0-359) of the coin's picture, added by the snapshots for the page backdrop (lib/tint.ts). */
  tint?: number;
  /** Estimated chance of Yes at the open (calibration table, then adjusted by this kind's realized results); the
   *  house seed is split by it so a 30% outcome opens paying about 3.3x. p0 is the raw table value. */
  p?: number;
  p0?: number;
  /** Calibration bucket the line came from (for the balance report). */
  calib?: string;
  /** double: the multiple of the opening market cap that wins (2 when absent). */
  mult?: number;
  /** double: the market cap that wins (a round milestone); mult is cap / the opening cap. */
  cap?: number;
  /** "est": a 1-hour round on an established coin (its own balance statistics). */
  tier?: "est";
  /** Rules version of the kind when this market opened (lib/resolved.ts RULES). */
  v?: number;
  /** Price rounds (flash, fast, updown, battle) run in two phases. Picks are open until lockAt; until then the line
   *  (target) follows the price. At lockAt the line is fixed (the average price over the last lockMs) and the round
   *  runs to closesAt with no more picks; it settles on the average price over the last closeMs. */
  lockAt?: number;
  locked?: boolean;
  lockMs?: number;
  closeMs?: number;
  /** Sealed market: the pool split and odds stay hidden from everyone until the market settles. While it is open,
   *  API responses carry the total pool split evenly (see lib/sealed.ts), never the real sides. */
  sealed?: boolean;
  story?: StoryRef;
  /** Pool liquidity (USD) when the market first saw it, and a flag once most of it has been pulled (a rug). */
  liq0?: number;
  halt?: "liquidity";
  /** The coin trades in a repeating sell-and-buy-back pattern (a volume bot) or collapsed to dust prices: set while
   *  open, so it is never featured. */
  bot?: "saw" | "dust";
  /** Where the outcome is read from, shown on the market page. */
  source: string;
}

export interface Player {
  id: string;
  name: string;
  balance: number;
  createdAt: number;
  /** Last daily-bonus claim (ms). */
  lastClaim?: number;
  /** Player code (second key to the account, "K7QM-4XRD"): restores it on another device. Never shown publicly. */
  code?: string;
  /** Internal test account: hidden from leaderboards and the activity feed. */
  test?: boolean;
  /** Daily challenges claimed, by UTC day ("2026-11-03": ["warm", ...]). */
  challenges?: Record<string, string[]>;
}

export interface Bet {
  id: string;
  player: string;
  market: string;
  side: Side;
  amount: number;
  at: number;
  payout?: number; // set when the market resolves (includes any streak bonus)
  /** The coin the market was about, kept on the pick so it can still be named exactly after the market is cleared. */
  mint?: string;
  sym?: string;
  /** Extra points paid by the house for a win on a 3+ win streak. */
  bonus?: number;
}
