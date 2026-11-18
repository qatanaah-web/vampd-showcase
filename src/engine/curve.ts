// ── Vamp'd showcase ── In the product: web/lib/curve.ts (server).
// Reads pump.fun bonding curves straight from Solana: PDA derived locally (incl. an ed25519 on-curve check), one batched RPC read.

// A pump.fun coin's bonding curve, read straight from the chain: the address is derived from the mint (no lookup),
// and one getMultipleAccounts call returns SOL raised and the "complete" flag for every curve market at once.
// This is the one source curve markets open on and settle on (the scanner's reading and DexScreener's were seconds
// apart and 20%+ off on a fast coin, so a line set on one was already passed on the other). Server only.
import { createHash } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58dec(s: string): Uint8Array {
  let n = BigInt(0); for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("base58"); n = n * BigInt(58) + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex; if (n === BigInt(0)) hex = "";
  let z = 0; for (const ch of s) { if (ch !== "1") break; z++; }
  return Uint8Array.from([...new Array(z).fill(0), ...Buffer.from(hex, "hex")]);
}
export function b58enc(buf: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0")), s = "";
  while (n > BigInt(0)) { s = B58[Number(n % BigInt(58))] + s; n /= BigInt(58); }
  for (const x of buf) { if (x !== 0) break; s = "1" + s; }
  return s;
}
// ed25519: is this 32-byte string a point on the curve? (A program-derived address must not be.)
const P = BigInt(2) ** BigInt(255) - BigInt(19), D = BigInt("37095705934669439343138083508754565189542113879843219016388785533085940283555");
const mod = (a: bigint) => ((a % P) + P) % P;
function pow(b: bigint, e: bigint) { let r = BigInt(1); b = mod(b); while (e > BigInt(0)) { if (e & BigInt(1)) r = mod(r * b); b = mod(b * b); e >>= BigInt(1); } return r; }
function onCurve(bytes: Uint8Array) {
  const le = Uint8Array.from(bytes); le[31] &= 0x7f;
  const y = BigInt("0x" + Buffer.from(le).reverse().toString("hex")); if (y >= P) return false;
  const y2 = mod(y * y), u = mod(y2 - BigInt(1)), v = mod(D * y2 + BigInt(1));
  const v3 = mod(v * v * v), v7 = mod(v3 * v3 * v), x = mod(u * v3 * pow(u * v7, (P - BigInt(5)) / BigInt(8))), vx2 = mod(v * x * x);
  return vx2 === u || vx2 === mod(-u);
}
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const cache = new Map<string, string>();
/** The bonding-curve account of a pump.fun mint (seeds "bonding-curve" + mint under the pump program). */
export function curveOf(mint: string): string | null {
  const hit = cache.get(mint); if (hit) return hit;
  try {
    const m = b58dec(mint), prog = b58dec(PUMP); if (m.length !== 32) return null;
    for (let bump = 255; bump >= 0; bump--) {
      const h = createHash("sha256").update(Buffer.from("bonding-curve")).update(m).update(Uint8Array.of(bump)).update(prog).update(Buffer.from("ProgramDerivedAddress")).digest();
      if (!onCurve(h)) { const a = b58enc(h); cache.set(mint, a); if (cache.size > 2000) cache.delete(cache.keys().next().value!); return a; }
    }
  } catch { /* not a valid mint */ }
  return null;
}

export interface CurveState { rSol: number; complete: boolean }
const RPCS = ["https://api.mainnet-beta.solana.com"];
/** SOL raised and the complete flag for each mint, from the chain. A mint is missing from the result when its curve
 *  account could not be read (the caller falls back to DexScreener). Free public RPC: one request per call. */
export async function readCurves(mints: string[]): Promise<Map<string, CurveState>> {
  const out = new Map<string, CurveState>(), pairs = mints.map(m => [m, curveOf(m)] as const).filter((x): x is readonly [string, string] => !!x[1]).slice(0, 90);
  if (!pairs.length) return out;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(6000), cache: "no-store",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [pairs.map(x => x[1]), { encoding: "base64", commitment: "confirmed" }] }) });
      const j = await r.json(); const v = j?.result?.value; if (!Array.isArray(v)) continue;
      v.forEach((a: { owner?: string; data?: [string, string] } | null, i: number) => {
        if (!a || a.owner !== PUMP || !a.data?.[0]) return; const b = Buffer.from(a.data[0], "base64"); if (b.length < 49) return;
        // disc 8, virtual token 8, virtual SOL 8, real token 8, real SOL 8 (@32), supply 8, complete 1 (@48)
        out.set(pairs[i][0], { rSol: Number(b.readBigUInt64LE(32)) / 1e9, complete: b[48] === 1 });
      });
      return out;
    } catch { /* next endpoint */ }
  }
  return out;
}
