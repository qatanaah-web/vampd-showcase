// ── Vamp'd showcase ── In the product: web/lib/guard.ts (API routes).
// Rate limiting and input guards: per-address limits paired with a global ceiling, so spoofed forwarding headers can't bypass it.

// Guards for the public API: who is calling, how often, and how big a body they may send. In memory, per process
// (one process owns the store), so limits reset on restart.
//
// Who is calling. The app sits behind a rewrite (Vercel) and a tunnel, so the socket address is a proxy's. The
// visitor's address is the first hop of the forwarding header the edge wrote. Order: x-vercel-forwarded-for (Vercel
// writes it itself and a visitor cannot set it through Vercel), then x-forwarded-for's first hop, then x-real-ip.
// A caller who reaches the tunnel directly can put anything in these headers, so every per-address limit is paired
// with a ceiling for all callers together: faking addresses gets around the first, never the second.
const g = globalThis as unknown as { __nmHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (g.__nmHits ||= new Map());

const IP = /^[0-9a-fA-F:.]{3,45}$/;
export function clientIp(req: Request): string {
  for (const h of ["x-vercel-forwarded-for", "x-forwarded-for", "x-real-ip"]) {
    const v = req.headers.get(h)?.split(",")[0].trim().replace(/^\[|\](:\d+)?$/g, "").replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1").replace(/^::ffff:/i, "");
    if (v && IP.test(v)) return v.toLowerCase();
  }
  return "local";
}

function sweep(now: number) {
  if (hits.size < 20_000) return;
  for (const [k, v] of hits) if (now - (v.at(-1) ?? 0) > 3_600_000) hits.delete(k);
  if (hits.size >= 20_000) hits.clear(); // flooded with made-up addresses: start over rather than grow
}
const recent = (key: string, windowMs: number, now: number) => (hits.get(key) || []).filter(t => now - t < windowMs);

/** Minutes (at least 1) until `key` is under `max` again, or 0 when it is under now. Does not count a hit. */
export function over(key: string, max: number, windowMs: number, now = Date.now()) {
  const r = recent(key, windowMs, now);
  return r.length >= max ? Math.max(1, Math.ceil((windowMs - (now - r[0])) / 60_000)) : 0;
}
/** Count one hit against `key`. */
export function hit(key: string, windowMs: number, now = Date.now()) {
  const r = recent(key, windowMs, now); r.push(now); hits.set(key, r); sweep(now);
}

export type Rule = { name: string; perIp: number; all: number; windowMs: number };
/** One request under a rule: null when allowed (and counted), or the 429 to send back. */
export function limited(req: Request, rule: Rule, extraKey?: string): Response | null {
  const now = Date.now(), keys = [[`${rule.name}:ip:${clientIp(req)}`, rule.perIp], [`${rule.name}:all`, rule.all]] as [string, number][];
  if (extraKey) keys.push([`${rule.name}:k:${extraKey}`, rule.perIp]);
  for (const [k, max] of keys) { const wait = over(k, max, rule.windowMs, now); if (wait) return tooMany(wait); }
  for (const [k] of keys) hit(k, rule.windowMs, now);
  return null;
}
export const tooMany = (waitMin: number) =>
  Response.json({ error: `Too many tries. Try again in ${waitMin} min.` }, { status: 429, headers: { "retry-after": String(waitMin * 60) } });

/** The JSON body as an object, or {} when it is missing, not JSON, not an object, or larger than `max` bytes. */
export async function body<T extends object>(req: Request, max = 2048): Promise<Partial<T>> {
  try {
    if (Number(req.headers.get("content-length") || 0) > max) return {};
    const text = await req.text();
    if (text.length > max) return {};
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
/** A string field of at most `max` characters, else "". */
export const str = (v: unknown, max = 64) => (typeof v === "string" && v.length <= max ? v : "");

// The rules. Generous per address (a household, a school or a phone carrier's NAT shares one), tight enough that
// a script cannot fill the store; the "all" ceilings only matter when someone fakes addresses.
const MIN = 60_000;
export const RULES = {
  join: { name: "join", perIp: 12, all: 600, windowMs: 60 * MIN }, //       new accounts
  rename: { name: "rename", perIp: 20, all: 1200, windowMs: 10 * MIN },
  pick: { name: "pick", perIp: 240, all: 6000, windowMs: MIN }, //          per address and per player (extraKey)
  claim: { name: "claim", perIp: 60, all: 3000, windowMs: MIN }, //         daily bonus and challenges
  lookup: { name: "lookup", perIp: 120, all: 6000, windowMs: MIN }, //      outbound lookups (siblings, pictures)
} satisfies Record<string, Rule>;
