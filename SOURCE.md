# What's in this repository

This is a curated selection from the private vamp'd codebase. It is a Next.js 16 / React / TypeScript app, and the market engine runs in the server process. I copied the files that show how markets are designed and kept fair, then reviewed each one. Every file starts with a header comment saying where it lives in the product.

This is **not a buildable app**. `src/engine/rounds.ts` is an excerpt of a larger engine, and imports such as the store, live feed and scanner client are left out.

## Included

| File | Why it's here |
|---|---|
| `src/engine/rounds.ts` | Two-phase rounds (pick, lock, live), the coin listing floor, fair opening odds, settlement and refunds, the spike guard, placing a pick |
| `src/engine/fair.ts` | Time-weighted settle price, payout, log-odds correction of the calibration by results, Wilson interval |
| `src/engine/decided.ts` | When picks close, and the "decided early" guards so no side is a free win |
| `src/engine/calibration.ts` | Line setting: the candidate line whose corrected chance is closest to 50%, inside 35–65% |
| `src/engine/curve.ts` | pump.fun bonding-curve reads from Solana. The program-derived address is computed locally, including an ed25519 on-curve test |
| `src/engine/resolved.ts` | The append-only settled-market log and per-kind / per-bucket stats |
| `src/engine/types.ts` | Shared shapes |
| `src/api/guard.ts` | Rate limiting: per-address limits paired with a global ceiling, plus body-size and field guards |
| `src/lib/paths.ts` | Base path and public origin for an app served under a sub-path behind a rewrite |
| `src/lib/question.ts` | Market wording: relative and local time, the line named, past tense once settled |
| `src/ui/LiveChart.tsx` | The live canvas chart (springs, continuous time) |
| `scripts/checks.mjs` | 24 checks of the arithmetic. **Runs here:** `node scripts/checks.mjs` (Node 22.18+) |
| `scripts/fairness.mjs` | The per-kind fairness report. It needs the private settled-market log, so here it only says there is no log |

## Left out, and why

- **Data:** the settled-market log, the player store, the calibration tables, and scanner history. They contain player names, account codes and live operating data.
- **Secrets and infrastructure:** environment files, RPC and API keys, hosting and tunnel configuration, machine names, deploy scripts.
- **The scanner and research code:** the launch scanner, trade tape and trading-research ledger live in a separate private project. This repo describes the research **method** and its negative results only. It contains no trading rules.
- **The rest of the app:** pages, API routes, styles, the sound and share-image code, and the launch-film project.

The numbers in the README come from the private reports and logs these checks were run against.
