# Earmark: guide for judges

Earmark lets a Sputnik DAO (including a Trezu treasury) vote once to give a team a budget. The team's lead then pays contributors inside written limits: small payments go out at once, medium ones need one approver, large ones become a normal DAO vote. A NEAR contract with no keys enforces the rules.

Track: Social Money (`social`). Everything below is public and needs no keys.

| | Link |
|---|---|
| Mainnet app (native USDC, Trezu treasury) | https://earmark-mainnet-878141445235.us-central1.run.app |
| Testnet app (all features, no wallet needed for "Try it") | https://earmark-878141445235.us-central1.run.app |
| Mainnet contract | [`budgets.omkar5.near`](https://nearblocks.io/address/budgets.omkar5.near) (0 keys), owned by [`earmark.sputnik-dao.near`](https://trezu.app/earmark.sputnik-dao.near) |

## Check it in 3 minutes

<!-- Every "quoted" label in the Do column must exist in the app: `make judge-check` (CI) fails otherwise. -->

| Do | You should see |
|---|---|
| Open the mainnet app's [`/verify`](https://earmark-mainnet-878141445235.us-central1.run.app/verify) | "Check it yourself": 0 keys on the contract, the code is the published build, code changed only by DAO vote #4, balances add up. Two amber rows say what the DAO allows (see "What we don't claim") |
| Open DAO vote [#5 in Trezu](https://trezu.app/earmark.sputnik-dao.near/requests?id=5) | A normal Trezu payment request, "Pay designer.omkar5.near through Earmark", approved there. Earmark filed it because 0.6 USDC was above the budget's one-approval limit, and paid the designer inside that vote |
| Open the testnet app and press "Try it, no wallet" | Real testnet transactions: a payment that goes out at once, one that needs an approval, and refusals with the contract's reason (unknown payee, same work twice, a race for the last funds, paused, a lead's key trying to approve) |
| On the testnet home page, open "Replay it yourself →" | NEARWEEK's 14,171 real mainnet proposals replayed: with a 1 NEAR limit and one approval up to 5 NEAR, the council votes on 20 of 13,896 payouts, and 121 repeat claims are blocked |
| On a budget page, open "How payments work" | The three paths with the budget's own limits, and how many DAO members a large payout needs |
| Run `make install && make verify NET=mainnet` | One PASS or WARN line per check and each mainnet transaction; the last line is `All checks passed. 4 warning(s): true facts, not failures.` |
| Run `make verify` | The same on testnet, plus 8 attacks re-read on chain; ends `8 of 8 attacks refused on chain` and `All checks passed.` |

The same checks run every 6 hours in CI ([Live checks](.github/workflows/live.yml)).

## The track prompt, and the proof

| The prompt asks for | Earmark | Proof you can open |
|---|---|---|
| Build on Sputnik DAO and Trezu, don't rebuild the multisig | The DAO's own proposals create, fund and close budgets; large payouts are normal DAO votes. Earmark adds no signers | Mainnet votes #1–#5 in [Trezu](https://trezu.app/earmark.sputnik-dao.near/requests); [Trezu forms](trezu/) for every DAO action |
| Shared budgets | One budget per team, with a period cap, per-lead limits and approved payees | `get_envelope` on [`/verify`](https://earmark-mainnet-878141445235.us-central1.run.app/verify) (Proof links) |
| Small payouts without a vote, mid-size with one member, large by the DAO | Three paths, decided by the contract | Mainnet txs in [`fixtures/mainnet.json`](fixtures/mainnet.json), checked by `make verify NET=mainnet` |
| Reputation tied to named accounts | Payee and lead records, counted only after a transfer succeeds; a clean record lets an approver raise a lead's limit up to a DAO ceiling | [`/people`](https://earmark-878141445235.us-central1.run.app/people); each record page has "Share record" |
| Bounties | Funded tasks: the money is reserved at posting; trusted contributors skip the extra approver, never the lead's review | [Tasks on testnet](https://earmark-878141445235.us-central1.run.app/budgets/0/tasks) |

## What is real

| | Mainnet | Testnet |
|---|---|---|
| Budgets, three payment paths, payee list, "ask to be paid" link, receipts | Yes, native USDC | Yes |
| Tasks (bounties), near.com payouts, Telegram alerts, fees paid by Earmark | Not yet: waits for one DAO-voted upgrade | Yes |
| Users | The builder's own accounts | Demo accounts |

## What we don't claim

- **The mainnet treasury is a 1-of-1 demo.** One member can pass every vote. `/verify` and the budget page say so. A real team should need 2 of 3.
- **The DAO's factory can still update the DAO's code** (Sputnik's `auto_update` is on). One DAO vote turns it off, from the app's `/update` page. `/verify` shows it until then.
- **No audit.** Unit tests, sandbox tests on the real Sputnik code, invariant tests and the live checks above.
- **No real users yet.** All payments are by the builder's accounts.
- **Payouts are public.** Every payee, amount and work link is on chain.
- **A lead and an approver who collude** can pay an approved payee up to the one-approval limit and the period cap. Caps, the payee list and public records limit this; they don't prevent it.

More detail: [README](README.md), [threat model](README.md#threat-model-and-limits), [invariants](README.md#invariants).
