# Market fairness

A prediction market is only fun if both sides are a real bet. These are the rules vamp'd holds every market type to, how each rule is enforced, and how it's checked.

## The seven principles

1. **One named source**, read the same way at the open and at the close. The source is printed on the market.
2. **The line is fixed after picks close, never before.** Price rounds run in two phases: picks, then lock, then live.
3. **No single trade can set the line or the result.** Both ends are time-weighted averages: 5 s / 10 s for 1-minute rounds, and up to 30 s / 60 s for 1-hour rounds. A tick that jumps more than 3% is held until the next tick confirms it.
4. **Both sides are a real bet.** The measured Yes rate must sit inside 35–65%, and a script fails when it doesn't.
5. **The first pick is not a free win.** The house seed is split by the measured chance, and a check asserts that a first pick at that chance returns under 1.00 on average.
6. **Every way a market can end is written on the market:** Yes, No, tie, dead feed, and a coin collapsing.
7. **A market that can't meet rule 4 is not opened.** Three types were retired for this reason.

These rules come from studying how others handle the same problems:
- Polymarket moved its 5- and 15-minute crypto rounds to a TWAP close.
- Kalshi averages 60 s at both ends of a round.
- PancakeSwap Prediction locks the price when betting ends.
- Parimutuel racing research shows that late bets carry information.
- Manifold writes resolution criteria up front.

## Where unfairness actually came from

| Symptom | Root cause | Fix |
|---|---|---|
| 1-minute rounds 79% Up (n=1,211) | Volume bots walking prices up with $1–2 trades | Listing floor on average trade size ≥ $20, plus a one-way guard per coin |
| Launch markets 69% Yes against a 47% table | Opening level read from a lagging source; target 2–6 SOL away on coins filling 10 SOL a minute | Open and settle from the on-chain curve; target at least a minute of the coin's current pace away |
| 6 of 49 launch markets settled wrong | Target touched between two polls; lagging price | Websocket account subscription, with a 5 s batched read as backup |
| Story markets refunded 30–70% of the time | Settled on the radar's last sighting, and the radar loses stories | Settle on market caps read at the close |
| Picks accepted 50 s into a 60 s round | One-phase rounds | Picks close at the lock |
| Calibration made things worse | It moved the seed toward observed rates but never the line, and it pooled all coins together | Choose the **line** on the results-corrected chance, per kind and per bucket |

## Closed-loop line setting

```
table chance p0 (from scanner history)
   → corrected in log-odds by results:  kind weight n/(n+30) from 10 results,
                                         bucket weight n/(n+40) from 15 results, capped at ±1.5
   → pick the candidate line closest to 50% inside [35%, 65%]
   → split the house seed by that chance
   → settle, log, and feed the result back into the correction
```

Results are counted per rules version, so when a kind's rules change, its old results stop steering it.

## The check

`node scripts/fairness.mjs [hours]` reports, per kind:
- the Yes rate with a Wilson 95% interval, before and after the rule change
- the seed estimate against the actual result
- refunds, split into those the market caused and those caused by server downtime
- the share of event markets decided in the first 5% of their window
- coins whose rounds close one way 85% of the time or more
- the median distance between the close and the line
- how many markets were taking picks, minute by minute

It exits 1 when a kind's whole interval sits outside 35–65%.

## Honest status

- Flash (1-minute) rounds are still at 69% Up (n=142), above the band, after the floor change. The one-way guard has been tightened from 10 rounds to 5, but that hasn't been re-measured yet.
- About a third of fresh coins that pass the floor still collapse within the hour. A collapse is a fair Down, so the bet stays even, but the coins themselves aren't safe.
