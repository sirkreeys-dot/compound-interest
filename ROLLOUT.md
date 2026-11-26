# Rollout

`DRY_RUN` stays the default. Do not point this at a wallet that holds more than `maxWalletSol` (default 1 SOL). Do not raise the committed floors. Each stage needs the previous stage's exit criteria, then a human reading the logs.

## 1. Dry-run for 7 or more days

Run with the committed example and `DRY_RUN=true`. A local `config.yaml` may set `fixedUsd: 1`. It must not weaken a safety floor or live mode will refuse to start.

Every dry-run buy logs `paper_vs_quote sizeUsd=… outUsd=… drift_bps=…`. That is the quote's USD out versus the USD we sized. To compare a later mark, run:

```bash
npm run drift -- 2 1.9
```

`drift_bps` of `-500` means the mark is 5% under the quote. Review the distribution over the week. Exit this stage only when:

- the process stayed up, or every restart recovered positions and pending rows without a second buy
- `sell_sim` lines are `passed`, `failed`, or `skipped`, and a skip was not treated as a fill
- paper drift is understood (median and worst `drift_bps` written down)
- no secret appears in logs or Telegram

## 2. Burner wallet, a few dollars

A new keypair. Fund it with well under 1 SOL and only the dollars you can lose. `DRY_RUN=false`. Keep `fixedUsd: 1` in the uncommitted config. Set `dailyBudgetUsd` no higher than the floor allows (the live floor refuses a daily budget above $40; use a lower number here, for example 5). `maxWalletSol` stays at 1 or lower.

Exit this stage only when a handful of round trips show:

- the signed message matched the simulation (`sign message bytes match simulation`)
- sells, the stop, and the kill switch still run while buys are paused
- a failed broadcast did not send a second transaction
- Telegram showed the entry, the exit, and any refusal, with no RPC key or private key in the text

## 3. Gradual increases

Raise size one step at a time, still under the committed caps (`fixedUsd` 2, per-trade 5, daily 40, daily-loss pause 20). Each step needs a clean log review: no unexpected `token_safety` pass, no overhead rejection that was then bypassed, no pending row left `unknown` without a person looking at it. Stop on the first halt (`consecutive_failures` or the kill switch) and do not resume until the cause is written down.

## Before any real money

Have someone who did not write this branch re-read the diff, the CI run, and a dry-run log. This repository cannot prove Jupiter, a paid RPC, and a live trap token together. Those three still have to be watched on the burner wallet.
