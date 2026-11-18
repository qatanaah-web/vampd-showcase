# Research hygiene: how a backtest lies, and the gates that catch it

Before vamp'd I built research tooling for Solana memecoin launches: a launch scanner, a trade tape, and a nightly ledger that grades candidate rules on history and forward data. The ledger tested more than 540,000 rules. This page covers the **method** and what it found. It contains no trading rules, because none survived.

## Failure modes found in my own pipeline

| Flaw | How it flattered results | Gate |
|---|---|---|
| **Stale exits** | A 60 s exit with no later trade was booked at the last known price. At a 60 s hold that covered 27% of triggers, where data showed they were sharply lower | Drop and count. If more than 30% of a rule's exits are stale, it can't pass |
| **Feed lag** | Fills were counted from the trade's block, but the feed delivered a quarter of triggers several seconds late | Delay each fill by that trigger's own measured lag |
| **Look-ahead in features** | A "crowd state at fill" feature used every trade with a block time before the *receive* second. On a lagging feed, that included trades from after the fill | Freeze features at the trigger. A rule that only exists with the leak is rejected |
| **Repeated launch scripts** | One operator with 39 dev wallets launched 600 coins, and they were counted as independent trades | Cluster by deployer, funding wallet and burst. Means and t-stats are taken per cluster |
| **Selection overlap** | Forward rows repeated scripts already seen in the selection window | Purge those rows, plus a 60 s embargo |
| **Outliers** | The top 3 trades made 66% of a rule's gains | Print the median, the mean without the top 3 and the cluster mean next to every mean. A rule negative without its top 3 can't pass |
| **Many rules tried** | Plain t-stats across hundreds of thousands of rules | Deflated Sharpe ≥ 0.95, White's reality check with a cluster bootstrap, cluster-robust SEs |

Methods: purged and embargoed walk-forward (López de Prado), the deflated Sharpe ratio (Bailey & López de Prado), White's reality check, and cluster-robust standard errors with the small-sample correction (Cameron & Miller).

## Two cases

**A "+21.5% forward" lead.** On two months of full history (Aug–Oct), the exact rule lost 4.6% per trade (n = 8,540, both halves negative, 1 of 9 weeks positive). All 48 neighbouring rules were negative too. Its recent result came from a single bundled-launch script: without that script's 40 trades, the rule was −1.0%. A shuffled-outcome test showed that the filter family really does pick *less-bad* coins. That is a different claim from being profitable.

**A "+18.7% per trade" crowd signal.** I built a waterfall of corrections, applied one at a time:
- adding back the coins the study had left out: +19.7%
- removing the look-ahead: **+3.2%** (t = 1.1)
- freezing the state at the trigger: the signal almost disappears (39 of 5,893 triggers), at −3.2%

Recreating the bug on purpose on history "made" +12.5% per trade with 55 of 62 days positive. That is a useful reminder of how convincing a leak can look.

## Outcome

After these gates went into the nightly ledger:
- Rules marked "holding": 63 → 16, and none of the 16 can go live.
- Of 623,033 rules searched, 51 were positive on both halves on plain means, and **0** stayed positive once the cluster mean and the without-top-3 mean were required.
- A reality check across the 197 rules with forward data gave **p = 0.93**: the best one is no better than luck.

The result is "nothing works yet". It's the most useful result the pipeline has produced, because it means the gates now work.
