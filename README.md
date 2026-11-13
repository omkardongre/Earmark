# Earmark

[![CI](https://github.com/omkardongre/Earmark/actions/workflows/ci.yml/badge.svg)](https://github.com/omkardongre/Earmark/actions/workflows/ci.yml)

Earmark gives teams in a Sputnik DAO (including Trezu-made treasuries) their own budgets, enforced by a NEAR contract with no keys.

- **Track:** Social Money (`social`), NEAR HACKATHON.
- **Hosted app (testnet):** https://earmark-878141445235.us-central1.run.app
- **Network:** testnet only. Payouts are public on-chain.
- **Machine-readable summary:** [`llms.txt`](llms.txt)

## The problem

NEAR communities pay people one DAO proposal at a time. NEARWEEK's news DAO (`nearweek-news-contribution.sputnik-dao.near`, mainnet) filed 14,171 proposals, almost all 0.5 NEAR for one news item. Its council decided them one by one: 5,153 approved, 7,199 rejected, 1,610 expired (full scan of every proposal).

The app's replay (`/preview`) reads that history live. With limits of 1 NEAR paid at once and 5 NEAR with one approval, the council would have voted on 20 of the 13,896 NEAR payouts. It also finds 121 requests for work already paid; 23 of them were paid twice. The method: same receiver and same first link in the description, share-tracking parts of the link ignored.

## What Earmark does

The DAO votes once to create and fund a budget for a lead it trusts. The lead reviews the work and pays from the budget:

- Small payouts inside the lead's limit go out at once.
- Medium payouts need one approver who is not the lead.
- Large payouts become a normal DAO proposal, paid from the main treasury.

The contract also enforces these rules:

- Money goes only to approved payees.
- Funds are reserved when a payment is requested, so two requests can't spend the same money.
- A retry with the same request id is refused, and the same work can't be paid twice.
- A clean record makes a lead eligible for a higher limit. An approver grants it, up to a DAO ceiling.
- Changes that loosen a rule wait out a delay any approver can cancel. Pausing applies at once.
- The contract has no access keys. Only a DAO vote can change its code.

## Try it in 3 minutes

No wallet needed for any of these steps.

| Do | See |
|---|---|
| Open the [hosted app](https://earmark-878141445235.us-central1.run.app) signed out | One line on what Earmark is, three tiles (paid at once / one approval / DAO vote) with live counts, and a route picker: enter an amount and a payee, see "pays now", "one approval", "DAO vote" or "blocked: why", from the contract's `check_spend` view |
| Open [`/try`](https://earmark-878141445235.us-central1.run.app/try) | Real testnet transactions on a sandbox budget: pay 5 (paid at once); ask for 40 and approve it as a council member (the page asks for 25 until the planned limit change applies); then five refusals, each with the contract's reason and the transaction: an unknown payee with the agent's key, the same work twice, two payments racing for the last funds, paying while paused, and the lead's key trying to approve (NEAR itself refuses the key) |
| Open [`/preview`](https://earmark-878141445235.us-central1.run.app/preview) ("Replay") | NEARWEEK's 14,171 real proposals replayed against two limits you set. The "Blocked" tile shows 121; "How we counted" shows 23 of them approved by the council |
| Open [`/budgets/0`](https://earmark-878141445235.us-central1.run.app/budgets/0) ("News contributors") | Available, waiting for approval and paid out, and every payment with its transaction. The 120 tUSDC payment to Sofia went to a DAO vote and shows "Paid by DAO"; its payment page links "Proposal #4" (on testnet this opens the DAO on NearBlocks, since Trezu has no testnet) |
| Open [`/people`](https://earmark-878141445235.us-central1.run.app/people) | Each contributor's paid count and total, each lead's record, limit and raise eligibility, and the council. Every number comes from a contract view |
| Open [`/verify`](https://earmark-878141445235.us-central1.run.app/verify) ("Check it yourself") | Live, keyless checks: 0 access keys, the code hash matches the recorded build, code changes only by DAO vote, the DAO is the owner, balances add up, ready for new payments. Each row has a "Proof" link to NearBlocks and the raw RPC answer |
| Run `make verify` | The same checks from a terminal, one PASS or FAIL line per check. No keys, no `.env` |
| Run `make demo` | Replay of the recorded testnet demo (19 steps): payouts at once, one approval, a DAO vote paid by the DAO, and refusals (`payee_not_allowed`, `duplicate_work`, `duplicate_request`, `not_spender`), each with its tx link. No network |
| Run `make test` | Contract unit tests, including the invariants table below |

The commands need `make install` first. See [Development](#development).

## Track prompt → Earmark

The Social Money example prompt asks for a bounty board with earned trust on Sputnik DAO or Trezu.

| Prompt asks for | Earmark |
|---|---|
| Use the existing DAO or Trezu treasury for custody and approvals; no new multisig | The DAO creates, funds, changes and closes budgets by its own proposals. Large payouts become normal DAO proposals. Earmark holds only the budget the DAO funded (see Threat model) |
| Members post small bounties; contributors finish them | A reviewed work item: the lead pays for finished work, with a work link (`work_ref`) |
| Payouts flow from the treasury | The budget pays out at once or after one approval; large ones are paid by the DAO itself |
| Reputation tied to named accounts, traceable to finished work | Payee record (`get_payee_record`) and lead record (`get_record`), counted only after a transfer succeeds; each payment links its transaction |
| A good record raises how much can be paid without a full vote | Lead eligibility (`eligible`): a clean record lets an approver raise the lead's limit, up to the DAO's ceiling, after a delay |
| Small payouts auto-approve, mid-size need one council member, large become a DAO proposal | Three tiers: paid at once / one approver / escalation to a DAO proposal |
| A public board with payouts and each contributor's record | `/people`, `/budgets/0` and the payment pages |

Limits attach to the lead, not the payee, because one person can open many accounts. Open bounties that anyone can claim (Sputnik `AddBounty`) are not built.

## Plain Sputnik vs what Earmark adds

| | Plain Sputnik DAO | With Earmark |
|---|---|---|
| Each payout | One Transfer proposal and a council vote | One vote funds a budget; small payouts need no vote |
| Medium payouts | Full vote | One approver who is not the lead |
| Large payouts | Transfer proposal | Earmark files one Transfer proposal (as a Requestor) that sends the money to Earmark; Earmark pays the payee and says "Paid by DAO" only after its own transfer succeeds |
| Who can be paid | Anyone the proposal names | Approved payees only; new payees wait out a delay |
| Overspending | Each proposal checked alone | Funds reserved at request; per-period cap per lead |
| Same work paid twice | Council must notice | Refused (`duplicate_work`) unless an approver overrides once |
| Contributor record | None | On-chain payee and lead records |
| Rule changes | A vote each | Tightening applies at once; loosening waits and can be cancelled |
| Code changes | n/a | Only by a DAO `UpgradeRemote` vote; the contract has 0 keys |

Sputnik pieces used: `FunctionCall` proposals (create, update, close a budget), Transfer with `msg` (fund a budget, and send an approved escalation's money to Earmark, both through `ft_transfer_call`), `UpgradeRemote` (new code), the Requestor role, `get_policy` and `get_proposal`.

## Invariants

Each row names the test that checks it. Tests are in [`contracts/earmark/src/tests.rs`](contracts/earmark/src/tests.rs) (`make test`) and [`contracts/earmark/tests/sandbox.rs`](contracts/earmark/tests/sandbox.rs) (`make test-sandbox`). The sandbox DAO test runs the exact Sputnik code of the mainnet treasury (`tests/res/sputnikdao2.wasm`, code hash `DtHZA1mU…hJXuF`, read with RPC `view_code`).

| Invariant | Test |
|---|---|
| Same request id twice: the second call fails | tests.rs::check_spend_agrees_with_request_spend |
| Two requests that together exceed the budget: only one reserves | tests.rs::second_request_cannot_spend_a_reservation |
| Escalation above available: escalates, reserves nothing, available unchanged | tests.rs::escalation_reserves_nothing_and_blocks_duplicate_work |
| Same payee and work while pending or paid: duplicate_work | tests.rs::escalation_reserves_nothing_and_blocks_duplicate_work, tests.rs::settle_escalation_records_each_dao_outcome |
| After override_duplicate: one repeat goes through | tests.rs::override_allows_one_repeat_of_the_same_work |
| After the first request fails: same work allowed again | tests.rs::failed_transfer_releases_reservation_and_work |
| Approver can't approve their own request | tests.rs::approver_cannot_approve_own_request |
| Payee not on the allowlist: fails | tests.rs::added_payee_waits_out_the_delay_and_removal_is_instant, tests.rs::check_spend_agrees_with_request_spend |
| Failed transfer: reservation returns, status Failed | tests.rs::failed_transfer_releases_reservation_and_work, sandbox.rs::payout_to_unregistered_payee_fails_and_releases_reservation |
| raise_limit for a spender who isn't eligible: fails | tests.rs::approver_cannot_raise_a_new_spender |
| Non-DAO caller on an owner method: fails | tests.rs::non_dao_cannot_create_envelope, tests.rs::only_dao_can_upgrade |
| ft_on_transfer from anyone but the DAO: full refund | tests.rs::non_dao_deposit_is_refunded |
| Loosening change before effective_at: apply_change fails | tests.rs::queued_change_cannot_apply_early |
| Raise queued, then DAO lowers the ceiling: apply_change fails | tests.rs::queued_raise_fails_after_dao_lowers_ceiling |
| Pause by any approver blocks in the same block | tests.rs::pause_by_approver_blocks_at_once, tests.rs::check_spend_agrees_with_request_spend |
| Payee approved but still in its delay: payee_pending | tests.rs::added_payee_waits_out_the_delay_and_removal_is_instant, tests.rs::check_spend_agrees_with_request_spend |
| check_spend and request_spend agree (15 states x 8 amounts; unknown budget id is `closed` in the view, `unknown_envelope` in the call) | tests.rs::check_spend_agrees_with_request_spend |
| Settling an escalation: rejected/expired/removed frees the slot and claim; approved gives PaidByDao and keeps the claim; twice changes nothing | tests.rs::settle_escalation_records_each_dao_outcome |
| "Paid by DAO" only after Earmark's own transfer to the payee succeeds; the DAO's money is accepted once, at the exact amount | tests.rs::dao_money_for_an_escalation_is_paid_out_once, sandbox.rs::dao_vote_pays_through_earmark |
| A failed payout keeps the DAO's money held for the request; a retry pays it | tests.rs::dao_money_for_an_escalation_is_paid_out_once, sandbox.rs::dao_vote_pays_through_earmark |
| Deleting a proposal after it paid frees nothing: the work stays claimed | tests.rs::dao_money_for_an_escalation_is_paid_out_once, sandbox.rs::dao_vote_pays_through_earmark |
| Approved but the money never reached Earmark: closed only 20 blocks after the vote | tests.rs::dao_money_for_an_escalation_is_paid_out_once |
| Delete only when every budget is closed and empty; the DAO gets the NEAR | tests.rs::contract_cannot_be_deleted_while_a_budget_is_open, sandbox.rs::payout_to_unregistered_payee_fails_and_releases_reservation |
| An escalation approved before an upgrade settles exactly once after it | tests.rs::escalation_from_before_the_upgrade_settles_once_after_it |
| Request 101 in a period: too_many_requests | tests.rs::request_cap_and_storage_float_block_new_requests |
| Removing the last approver who isn't that spender: refused | tests.rs::cannot_leave_a_spender_as_their_own_only_approver |
| Task: reserved at posting, paid through the usual tiers on accept, counted for trust only when paid | tests.rs::task_reserves_at_posting_and_pays_through_the_tiers |
| Trusted contributor: no approver up to the trusted limit, approver above it; a for-cause rejection removes trust | tests.rs::trusted_contributor_skips_the_approver_until_a_strike |
| Task payment fails: reservation held again; closing the budget cancels the task and frees it | tests.rs::failed_task_payment_holds_again_and_close_cancels |
| One open claim per contributor; anyone reopens a claim after its deadline | tests.rs::claims_expire_and_one_is_open_at_a_time |
| Upgrade from the R23 layout keeps everything and adds tasks | tests.rs::tasks_survive_the_upgrade_from_the_r23_layout, sandbox.rs::mainnet_upgrade_rehearsal |
| Payee record grows when the DAO pays, never on failure | tests.rs::settle_escalation_records_each_dao_outcome, tests.rs::failed_transfer_releases_reservation_and_work |

Not yet tested, or only partly:

- balance = available + committed + in_flight after every call. Only spot checks in tests; `/verify` and `make verify` check it on the live contract.
- Two requests that are each over available both fail.
- Reserved in one period and failed in the next.
- Payee removed while a request waits (approve should fail with `payee_not_allowed`).
- `raise_limit` above the ceiling, called directly.
- Non-DAO caller on every owner method (only `create_envelope` and `upgrade` are tested).
- A cancelled change can't be applied.
- Payee record on a normal `spend_paid` (not unit tested).

## Threat model and limits

- **Funds sit in the contract.** The DAO moves a budget into Earmark, so the budget is in escrow, not in the treasury. This bounds what a lead can spend, but a contract bug could lose that budget. The DAO can close a budget and get the free balance back.
- **A lead and an approver who collude are not stopped.** They can pay an approved payee up to the one-approval limit and the period cap. Payee allowlists, caps and public records limit the damage; they don't prevent it.
- **Payouts are public.** Every payee, amount and work link is on-chain. There is no confidential mode.
- **No audit.** The contract has unit and sandbox tests only.
- **Trezu-shaped DAOs let a Requestor remove proposals.** In the policy Trezu gives new treasuries, a Requestor can remove pending proposals, including Earmark's escalations. `settle_escalation` then records the escalation as closed and frees the lead's slot. Removing a proposal after the DAO's money arrived changes nothing: the request is no longer `escalated`, so its work stays claimed.
- **DAO payouts need the payee registered with the token.** If not, Earmark keeps the DAO's money for that request (`dao_funded`) until a retry pays it, or the DAO takes it back with `return_escalation`.
- **Mainnet is one small run.** `budgets.omkar5.near` holds a 1 USDC budget for the Trezu treasury `earmark.sputnik-dao.near`; its setup, funding and DAO-vote payment all showed in Trezu as normal requests. Amounts are tiny (1 USDC budget).
- **The "Try it" server holds two testnet keys.** Both are function-call keys on the sandbox contract `try.earmark.testnet` only. `try-lead.earmark.testnet` can call only `request_spend`; `try-council.earmark.testnet` can call only `approve` and `expire`. A stolen key can only make allowlisted payments within the sandbox's caps.

## NEAR pieces used

- **Sputnik DAO v2:** `FunctionCall` and Transfer proposals, Transfer with `msg`, `UpgradeRemote`, `get_policy`, `get_proposal`, the Requestor role (Trezu's policy shape).
- **NEP-141:** the budget token (`tusdc.earmark.testnet`, a test stablecoin), funded through `ft_transfer_call` and paid with `ft_transfer` and a callback.
- **NEP-145:** payee registration check (`storage_balance_of`) and one-click `storage_deposit`.
- **NEP-297:** contract events (standard `earmark`), used by the app's activity feed.
- **NEP-330:** `contract_source_metadata` names the source commit and the pinned build image.
- **Function-call access keys:** an agent or bot key that can call only `request_spend`.
- **FastNEAR:** RPC for reads (near.org as fallback) and the FastNEAR transactions API to find the transaction behind each event.

## Built with

- Contract: Rust, [near-sdk](https://github.com/near/near-sdk-rs) 5.29.1 and near-contract-standards 5.29.1, built with [cargo-near](https://github.com/near/cargo-near) 0.22 in the `sourcescan/cargo-near` Docker image. Tests use near-sandbox, near-api, tokio, testresult and serde_json.
- Web app: [Next.js](https://nextjs.org) 16, React 19, Tailwind CSS 4, [near-api-js](https://github.com/near/near-api-js) 7, [`@hot-labs/near-connect`](https://github.com/hot-dao/near-connect) 0.12 for wallets.
- Scripts: Node.js 24, TypeScript, near-api-js, tsx.
- Tooling: pnpm, Biome, rustfmt, clippy, GitHub Actions, Google Cloud Run and Cloud Build.
- No starter template. The first commit is from 2 Nov 2026.
- Built with AI coding assistants (Kiro with Claude models) under human review.

## Status

Working on testnet:

- Contract `budgets.earmark.testnet` with the demo budget, and the sandbox contract `try.earmark.testnet` for "Try it".
- The hosted app, the replay, the Verify page, `make verify` and `make demo`.

Working on mainnet (small run, 9 Nov, native USDC):

- Contract `budgets.omkar5.near` (0 keys), owned by the public Trezu treasury `earmark.sputnik-dao.near`; app at https://earmark-mainnet-878141445235.us-central1.run.app.
- `/setup` filed the setup and funding votes; Trezu showed them as normal requests and they were approved there.
- All three payment paths with a real wallet: 0.1 USDC paid at once, 0.4 USDC after one approval, and 0.6 USDC sent to a DAO vote. The vote showed in Trezu as a "Payment Request · 0.6 USDC", was approved there, and "Check the DAO result" recorded it as paid by the DAO.

Not done:

- Confidential (NEAR Business / NEAR Intents) treasuries: not tried. Mainnet used a public Trezu treasury.
- Audit.
- Wallet tests of payee registration and add payee.
- No live customer yet.

---

## Development

Requirements: Rust (toolchain pinned in [`rust-toolchain.toml`](rust-toolchain.toml)), [cargo-near](https://github.com/near/cargo-near), Node.js 24, pnpm 10 and Docker (sandbox tests and reproducible builds).

| Command | What it does |
|---|---|
| `make install` | JS dependencies |
| `make build` | Contract WASM |
| `make test` | Contract unit tests |
| `make test-sandbox` | Integration tests on a local NEAR node (Docker) |
| `make lint` | rustfmt, clippy, biome |
| `make verify` | Check the live testnet deployment (no keys, no `.env`; tx lookups use archival RPC) |
| `make demo` | Replay the recorded testnet demo with tx links (no network) |
| `make web` | Web app on http://localhost:3000, reading the testnet demo |
| `make web-build` | Production build of the web app |
| `make deploy` | Build on Cloud Build and deploy to Cloud Run |
| `make deploy-mainnet` | The same for the mainnet app (`earmark-mainnet`) |
| `make try-refill` | Top up the "Try it" sandbox |
| `make try-scenes` | Create the race and paused sandbox budgets (idempotent) |
| `make try-limits` | Move the sandbox to 5 at once / 50 with one approval (DAO vote, then the 1-day delay) |

### Repository layout

| Path | Contents |
|---|---|
| [`contracts/earmark`](contracts/earmark) | NEAR smart contract (Rust, near-sdk) |
| [`contracts/test-token`](contracts/test-token) | NEP-141 test stablecoin for testnet and sandbox (owner can mint) |
| [`apps/web`](apps/web) | Web app (Next.js 16); see [Web app](#web-app) |
| [`scripts`](scripts) | Node scripts for verification and the demo |
| [`scripts/verify`](scripts/verify), [`scripts/demo`](scripts/demo) | `make verify`, `make demo`; both read [`fixtures/testnet-demo.json`](fixtures/testnet-demo.json) |
| [`fixtures`](fixtures) | Every transaction of the recorded testnet demo, with its expected outcome |
| [`scripts/testnet`](scripts/testnet) | Testnet setup; see [Testnet scripts](#testnet-scripts) |

### Contract methods

| Who | Methods |
|---|---|
| DAO (FunctionCall proposal) | `create_envelope`, `update_envelope` (any rule change), `close_envelope`, `return_escalation` (take back the money held for a payout that keeps failing), `delete_contract` (retire Earmark: deletes the contract account and sends its NEAR to the DAO); `upgrade` (new code, `UpgradeRemote` proposal); funds a budget with a Transfer proposal with `msg` (`ft_transfer_call`) |
| Spender (or its agent key) | `request_spend`; tasks: `post_task`, `accept_task` (the lead who posted it), `reject_work`, `cancel_task` |
| Approver | `approve`, `reject`, `override_duplicate`, `approve_payee`, `approve_intents_payee` (near.com), `remove_payee`, `raise_limit`, `lower_limit`, `pause`, `unpause`, `cancel_change`; tasks: `reject_work`, `cancel_task` |
| Approved payee (not a lead or approver of that budget) | `claim_task`, `submit_work`, `release_claim` |
| DAO | also `set_task_rules` (trusted contributors on or off, and what earns it) |
| Anyone | `expire`, `apply_change`, `settle_escalation`, `release_claim` after the claim's deadline, views (`check_spend`, `get_envelope`, `list_requests`, `get_request`, `get_record`, `get_payee_record`, `eligible`, `list_queued`, `get_change`, `list_tasks`, `get_task`, `get_task_rules`, `get_contributor_trust`, `check_accept`, `list_intents_payees`, `is_intents_request`) |

### Tasks (bounties) and trusted contributors

**Installed on testnet** (11 Nov, reproducible build at `a5dcb74`, code `6H2m7r…BhRx`, DAO proposals 19 and 20; trust turned on for budget 0 by proposal 21: trusted after 2 accepted, paid tasks, up to 30 tUSDC). **Not on mainnet yet:** it goes in one upgrade together with NEAR Intents payouts, so mainnet still runs `G3SbqW…ZXtX` and its app says tasks aren't available. Research: `research/solution-research/17-bounty-board-research-2026-11-11.md`.

- **Post:** a lead posts a task (title, brief link, amount, days to finish, optionally "only for" one payee). The amount is reserved in the budget at once (`committed`), so the contributor knows the money is there. A task is at most the one-approval limit; bigger work stays a normal request that goes to a DAO vote. Posting counts toward the lead's 100 requests per period, and a budget holds at most 50 reserved tasks.
- **Claim and submit:** an approved payee who isn't a lead or approver of that budget claims it (one open claim, three when trusted) and sends a work link. The same work link can't be paid twice for them (`duplicate_work`). After the deadline anyone can reopen the claim.
- **Accept:** the lead who posted it accepts. The reservation is freed and the payment is made as a normal request `task-<id>-<attempt>` in the lead's name, with every rule checked again and the usual tier. The payment page, receipt, CSV and records work unchanged. If the payment fails, is rejected by an approver or expires, the task goes back to "work sent" with its money reserved again (or is cancelled if the budget closed or the money is gone). Closing a budget cancels its open tasks.
- **Reject:** the lead or an approver sends the work back to fix, or rejects it as not acceptable (spam, copied, not done), which reopens the task and is a strike against the contributor in that budget.
- **Trusted contributors** (`set_task_rules`, off by default): after `min_tasks` accepted, paid tasks in a budget, over `min_days`, with no strike in `strike_days`, a contributor is trusted there. The lead still accepts every payment; trust only removes the approver: payments to them clear at once (tier `trusted`) up to `trusted_limit`, which can't exceed the one-approval limit. Trust counts only tasks a lead accepted and that were paid, never on failure. No payment ever happens because nobody objected.

### near.com payees (NEAR Intents)

**Installed on testnet** (12 Nov, reproducible build at `508a355`, code `DGwhd93…UGrx`, DAO proposals 22 and 23), but off there: Intents has no testnet, so `intents_contract` is none and the app hides the option. Tried end to end on a throwaway contract paying a copy of the real Intents code. **Mainnet waits** for the one combined upgrade with tasks. Research: `research/solution-research/19-intents-receiving-verified-2026-11-11.md`.

- **What it is:** an approver pastes a wallet address (`0x…`) in Add payee, and the app pays it on near.com (`approve_intents_payee`, same waiting period as any new payee). Earmark pays them with `ft_transfer_call` to the Intents contract with `msg` = their account id and nothing else, so it lands in their near.com balance. They withdraw on near.com with the same wallet (MetaMask, Phantom, passkey or a NEAR wallet) to Base or any other chain. A MetaMask user's id is their `0x…` address, lowercase. No token setup is needed for them.
- **Paid only on full credit:** the payment counts as paid only when the token reports the full amount was kept (`ft_resolve_transfer`). A refund (Intents paused, bad id) fails it like any failed transfer: the money stays in the budget and the work link is free again. Earmark never sends Intents actions, so the Oct 2026 refund exploit (it needed a notify action) doesn't apply.
- **Kept per payment:** whether a request goes to near.com is fixed when it's made (`is_intents_request`). Removing or re-adding the payee doesn't redirect it. To switch a payee's destination, remove and add them again (the new destination waits like a new payee).
- **Where:** `intents_contract` is `intents.near` for a `.near` contract (set by `migrate`, shown in `get_config`) and none elsewhere, because Intents has no testnet. A test deploy can name its own copy in `new`.
- **DAO votes:** the gas left inside a Trezu vote (~28 Tgas) isn't enough for this payout, so a near.com payee's DAO-funded request waits as `dao_funded` and `settle_escalation` pays it ("Pay it out" button).
- **App:** Add payee has one box (also on the budget's People list, for approvers). On a contract that can pay near.com, a `0x…` address is always a near.com payee, so a MetaMask address never becomes a plain NEAR payee by mistake; a NEAR account can be paid there by choice ("Pay into their near.com balance instead"). Payees get a near.com tag, and the payment page says "Paid into X's near.com balance", with "Withdraw on near.com" for the payee (hidden for the signed-in team). Earmark's part ends at the credit; it doesn't track the withdrawal.
- **Gas, measured on testnet** (Intents copy): a payout at once burnt 16.3 Tgas in total and an approval 15.8 Tgas; the app's 100 Tgas covers both.

### Fees paid by Earmark (NEP-366) and Telegram alerts

**Live on the testnet app since 13 Nov** (no contract change: the contract already identifies people by `predecessor_account_id`). Plan: `docs/05-feature-4-8-plan.md`; research 20 and 21. Mainnet after the contract upgrade, with its own sponsor and bot.

**Fees paid by Earmark:**
- **What it does:** a lead, approver or contributor signs the call in their wallet as a NEP-366 delegate action. `POST /api/relay` sends it from the sponsor account `gas.earmark.testnet`, which pays the gas. The call still runs as the member, so the contract checks their role as usual. The sponsor has no role in any budget or DAO.
- **What the relay accepts:** one FunctionCall to this deployment's contract, with no deposit, at most 100 Tgas and 2 KB of args. The method must be one the app uses (`lib/relay.ts` `RELAY_METHODS`; not setup, upgrades, DAO-only or close). The sender must be a spender, approver or payee of an open budget, and the signature must check out against one of the sender's keys before anything is sent.
- **Caps:** per sender a day (50 testnet, 30 mainnet) and in total (1 NEAR testnet, 0.3 mainnet). It stops when the sponsor has under 0.3 NEAR. Counts live in Firestore and count failed calls too. `RELAY_OFF=1` turns it off.
- **In the app:** with a wallet that signs delegates (Meteor; NEAR Mobile and HOT on mainnet only), the main buttons show "No network fee for you" (while the wallet asks: "Sign in your wallet. Earmark pays the network fee."), the success message and the pay sheet say "Network fee paid by Earmark", and a payment page shows "Network fee: Paid by Earmark" when a step was relayed. Other wallets work as before. If the relay refuses, the app asks before using the wallet's own NEAR ("Pay the fee myself"). Retries are safe: the contract refuses a repeated request id or work link, and the delegate nonce stops a replay.
- **Checked on testnet:**
  - `make relay-smoke APP=http://localhost:3005`: maya asks, priya approves, both relayed (txs `GVHds1…`, `HMmXQW…`);
  - `APPROVER=carol.earmark.testnet`: carol, with 0.00068 NEAR free, approves and her balance doesn't move (tx `EuEBT7…`);
  - about 0.0004 NEAR per relayed call;
  - 13 Nov, hosted app: carol approved twice from Meteor with ~0 NEAR; the fee came from `gas.earmark.testnet`.
- **History:** a relayed transaction is signed by the relayer, so the history (`lib/near.ts` `contractEvents`) takes who acted from the delegate action's `sender_id`; a relayed pause shows "Paused by Carol", not the relayer.

**Telegram alerts:**
- **Linking:** leads and approvers see "Telegram alerts" on a budget page: "Connect team chat" gives a one-time `t.me/<bot>?startgroup=<code>` link, and the panel says "On" once a chat is connected (`GET /api/alerts/status`, a count only). "Just me instead" links your NEAR account to your Telegram user, so alerts @mention and DM you. A pending payment's page has "Tell me on Telegram when it's paid"; a task page has "Follow on Telegram". `/stop` in a chat ends its alerts.
- **What gets posted:** each message is a bold headline and one detail line, e.g. "**✋ 10.5 tUSDC to Bob needs approval** / News contributors · asked by Maya · expires Sun 15 Nov, 21:28 UTC". Only approvers who linked Telegram are @mentioned. The bot posts work to review, payments that need an approver (with who asked and when it expires), rule changes ("can be applied after …, any approver can cancel"), and then edits the same message to "✅ Paid", "Not paid" or "Failed". It sends one reminder 6 h before a payment expires. DAO votes are left to Trezu's own alerts.
- **The bot has no power:** buttons open Earmark (`/approvals#pay-<id>`), where the wallet signs. Alerts carry only public chain data, so linking needs no wallet signature.
- **How it runs:** Cloud Scheduler calls `/api/cron/alerts` every minute (header `x-cron-secret`). It reads each open budget fresh (never the page cache), compares it with the last snapshot in Firestore and posts what changed. A new subscription records the current state first, so it isn't flooded with old items. A crash can repeat at most one message, and no money moves. The webhook `/api/telegram` checks Telegram's `secret_token` header.
- **Checked on testnet:** first with a fake Telegram, then (13 Nov) with the real bot `@EarmarkTestnetBot` in a group: `scripts/testnet/relay.ts ask <app>` made a 10.5 tUSDC request over Maya's limit → the group got the alert; "Review payment" opened the highlighted card; carol approved → the message was edited to "✅ Paid" within a minute.

The approval card shows the amount, payee, who asked and the time left (amber under 6 h), the note with "View work ↗", then up to four rows: Why you ("Over Maya's 10 tUSDC limit"), Budget left (this payment is already set aside), Paid before ("5 times · 197 tUSDC", from `payeeHistory`, this budget only, not `get_payee_record`, which mixes tokens) and From task. Approve is the wide main button.

Changes that loosen a rule (raise a limit, add a payee, unpause, ...) are queued for `loosen_delay_secs` (120 s on testnet) and any approver or the DAO can cancel them. Changes that tighten apply at once. `apply_change` refuses a queued change older than 14 days.

### Safety limits

- **DAO votes pay through Earmark (R22).** An escalation is a Transfer proposal that sends the amount to Earmark with `{"request_id": …}`. Earmark accepts exactly that amount once, while the request is `escalated`, and pays the payee in the same transaction (a Trezu vote leaves enough gas). Only when that transfer succeeds is the request `paid_by_dao` and counted in the records. If the payout fails, the request is `dao_funded` and the money stays held; anyone can retry with `settle_escalation`. A second payment, a wrong amount or a closed request is refunded to the DAO.
- **Escalations settle.** `settle_escalation` reads the DAO proposal while a request is `escalated`: rejected, removed, expired or moved → `escalation_closed`. Approved but the money never arrived (20 blocks, about 11 s, after the vote) → `escalation_closed` (`dao_payment_returned`). A proposal filed before R22, which paid the payee directly, → `paid_by_dao` once it has stayed approved for 20 blocks (Sputnik turns it `Failed` if its transfer fails). Each outcome frees the lead's DAO-vote slot (max 5 open). The payment page has a "Check the DAO result" button, and "Try the payout again" for `dao_funded`. **Installed on testnet** (10 Nov, reproducible build at `d68dc6c`, code `G3SbqW…ZXtX`, DAO proposals 17 and 18; R22 first at `23c86db` by proposals 14 and 15). Checked live: proposal 16 paid Sofia 60 tUSDC through Earmark. The testnet DAO runs older Sputnik code that gives Earmark only ~1.4 Tgas in the vote, so the payout ran in a second step (`settle_escalation`, tx `3pjSD9E1…`); the mainnet DAO's code leaves enough to pay inside the vote (sandbox test). **Installed on mainnet** (11 Nov, same code `G3SbqW…ZXtX`) by DAO proposal 4, filed and approved from `/update`.
- **Retiring Earmark (R23).** `delete_contract` is DAO only. It is refused unless every budget is closed and empty and no DAO vote or held DAO payment is open; it then reads the contract's balance of every allowed token and deletes only if all are zero, since tokens in a deleted account are lost. The NEAR always goes to the DAO.
- **Request cap.** At most 100 requests per spender per budget period, and no new request while the contract has less than 0.5 NEAR free for storage.
- **Approvers.** Every spender keeps an approver other than themselves (`no_other_approver`).
- **Removal.** Removing a spender cancels their waiting changes and blocks approval of their pending requests.
- **Payee record.** `get_payee_record` counts confirmed payments to each payee, across budgets.
- **Escalation text.** DAO proposals use the format Trezu reads. The title names the real payee, since the proposal's recipient is Earmark: `* Title: Pay <payee> through Earmark <br>* Notes: <memo> · by <spender> · budget <n> · request <id> <br>* Url: <work link>`.
- **Upgrades.** `migrate` converts the state layout from before these limits, so the live contract can be upgraded through a DAO vote.

### Testnet demo

- Contract `budgets.earmark.testnet`: reproducible build, no access keys, so only a DAO vote can change its code.
- DAO `community-news.sputnikv2.testnet` with the policy Trezu gives new treasuries: Requestor / Admin / Approver, 2 of 3 council votes, bond 0. The contract is a Requestor so it can file escalations.
- Token `tusdc.earmark.testnet`.
- Budget 0 "News contributors": leads Maya and Theo, council Priya, Daniel and Lena, contributors Sofia, Kenji and Ana.
- The earlier deployment (`v4.earmark.testnet`, DAO `earmark-demo.sputnikv2.testnet`) stays readable; its fixture is in [`fixtures/archive/`](fixtures/archive).

### Web app

Screens in [`apps/web`](apps/web):

- **Landing** for signed-out visitors: one line, live counts per payment path with the latest of each, links to Try it and the replay, and a route picker (amount + payee → pays now / one approval / DAO vote / blocked, from the live `check_spend` view, no wallet).
- **Budgets home** with recent payments: one row per payment showing its latest step, 5 at a time, rule changes left out ("Show more" pages older history through `/api/activity`). People show by name ("Sofia Reyes" for `sofia-reyes.earmark.testnet`); the full account stays in links and the pay sheet.
- **Ask to be paid** (`/budgets/<id>/request`, no wallet needed): a contributor picks who they are (preset when signed in as a payee), the amount, the work link and a note, and gets a link to send their lead (Copy or Share). The link opens the budget page with a "Writer asks to be paid 0.2 USDC" line and the pay form filled in once a lead signs in; the link leaves the address bar so a reload doesn't reopen it. Nothing is stored: the fields are only suggestions ([`lib/request-link.ts`](apps/web/src/lib/request-link.ts) drops a link whose payee isn't on the budget, whose amount isn't valid, or whose text is over the contract's 256-byte limit), the lead reviews them, and the contract checks every rule. Signed-in payees see an "Ask to be paid" button on the budget card.
- **Tasks** (`/budgets/<id>/tasks`, `/tasks/new`, `/tasks/<n>`): the board (Open, In progress, Paid) and a task page with one main action for whoever is signed in: "Take this task", "Send the work", "Accept and pay" (with the tier from `check_accept`), "Send back to fix" (rejecting as not acceptable is a separate red link with a confirm), "Cancel task", "See the receipt". The task page reloads the task itself after each action, and checks a work link with `check_spend` before the wallet opens, so an already-paid link is refused without a fee. Screens follow the signed-in person's role in the budget: home shows "Needs you" (work to review, work to send or fix, payments to approve) and "N tasks you can take"; a contributor's budget page shows only tasks, their own payments and "You earned X here". The budget page lists active tasks; a person's page shows "Trusted up to X" per budget. On a contract without tasks the views fail with `MethodNotFound` and the app says tasks aren't available instead of failing.
- **Receipt**: a paid payment's page has "Download receipt", which opens the browser's print dialog ("Save as PDF"). The print view drops the nav and buttons and adds a "Payment receipt" title, the payout transaction hash and link, and the receipt id. No PDF library or server rendering.
- **Budget page**: payments table with filters and `list_requests` paging; animated budget numbers (still with reduced motion); CSV export (`/api/export/<id>`: UTC date, request id, payee, exact amount, token, status, work link, tx; cells starting with `= + - @` are quoted against formula injection).
- **Payment page** `/payments/[id]`: steps, each with its transaction.
- **Payment sheet**: the tier shown before you send; a payee registration check (NEP-145 `storage_balance_of`; one-click `storage_deposit` with the deposit read from `storage_balance_bounds`), also used when an approver adds a payee.
- **Approvals**, shown only to approvers: approve, reject, "Recently decided" with when, and folded controls for waiting changes, pause with a confirm step, raise (a small sheet: new amount with the max and the wait shown, one "Raise to …" button), and payees. A change queued here (raise, unpause) shows with its Cancel button at once, before the server list catches up; every toast says "Network fee paid by Earmark" when the relay paid. "Add" a payee in one step: if the token doesn't know them yet, the same click pays their registration first (the wallet asks twice); the new payee shows in the list with its countdown and a "Make payable" button. The nav badge reloads its count (`/api/queue`) after each action.
- **People** `/people` and person pages: contributor and lead records from the contract.
- **Try it** `/try`, **Replay** `/preview` (replays a mainnet Sputnik DAO's payout history against draft limits), **Check it yourself** `/verify` and **Set up a budget** `/setup` (sections below).

How it reads and writes:

- Reads try each RPC in `RPC_URLS` (FastNEAR, then near.org). On the server they fall back to the last good value with a "showing values from <time>" notice.
- Wallets via `@hot-labs/near-connect` (EVM wallets and NEAR CLI hidden). Reads use public RPC. Transactions are found through the FastNEAR tx API (never cached).
- After a transaction the app reloads its data three times over ~7 s and screens update their own state, because the chain and the indexer lag and `router.refresh()` is unreliable on Next 16 ([vercel/next.js#99028](https://github.com/vercel/next.js/issues/99028)).
- Modal sheets close while the wallet asks, since a top-layer `<dialog>` would cover the wallet popup.

### Check it yourself (`/verify`)

Live, keyless checks of `budgets.earmark.testnet`, the browser version of `make verify`:

- 0 access keys.
- The code hash matches the recorded reproducible build, and `contract_source_metadata` names the commit and the pinned Docker image. The current hash is shown on the page and printed by `make verify`.
- Code changes only by DAO `UpgradeRemote` votes: the contract deployed itself once, then deleted its key.
- The DAO is the owner.
- Balances add up: token held ≥ budgets, balance = available + waiting + paying, paid requests = paid out.
- Ready for new payments: the contract has at least 0.5 NEAR free for storage. If not, the row (and the Approvals page) says how much NEAR to send it; a lead only sees that payments are paused.

Each row has a "Proof" link that opens its NearBlocks pages and the raw RPC answer (`/verify/rpc/<check>`). A read that fails (e.g. a rate limit) is retried once; if it still fails the row shows "Couldn’t check this right now" in gray and isn't counted as failed. The expected DAO and code hash are in [`apps/web/src/lib/config.ts`](apps/web/src/lib/config.ts) (`EXPECTED_DAO`, `EXPECTED_CODE_HASH`; override with `NEXT_PUBLIC_DAO`, `NEXT_PUBLIC_CODE_HASH`). Update them when `lock.ts` installs new code.

### Set up a budget (`/setup`)

Enter the DAO and fill in one form: name, amount, period, leads and their limits, the one-approval limit, approvers (pre-filled from the DAO's Approver role, else its council) and who can be paid. The app reads `get_policy`, checks every account exists and the limits are consistent, and lists the DAO proposals it will file in plain words (people by name), with the exact `add_proposal` JSON and full accounts under Details. If the contract can't file DAO votes yet, the plan first adds it to the Requestor role (or a new role that can only file transfers). Filing stops if the DAO has too little free NEAR for the budget's storage deposit (0.1 NEAR) plus proposal storage; a new Trezu treasury has ~0.07 NEAR free. The connected wallet files the proposals. After the council approves the budget, the same page (its URL keeps the place, and it re-reads open votes every 10 s while visible) files the funding transfer once; it finds an open or passed funding vote for the budget, so it isn't filed twice. One contract serves one DAO.

Signing out or switching accounts returns to the home page and resets every screen.

### Try it (no wallet)

`/try` lets a visitor drive a separate sandbox contract, `try.earmark.testnet`: same code, no access keys, owned by the demo DAO. Budget 0 "Try it" has auto limit 5, one approval up to 25 (50 once `make try-limits` applies the queued change), a 1-hour period and a 10-minute approval window. Budgets 1 and 2 hold the race and paused scenes, so budget 0 stays open.

- The server signs with two testnet function-call keys: `try-lead.earmark.testnet` can only call `request_spend`, `try-council.earmark.testnet` only `approve` and `expire`, both only on the sandbox contract.
- Visitors choose a scene; they never send amounts or payees.
- `/api/try` allows 20 actions per visitor and 300 in total per 10 minutes (the race counts as 2). Limits are in memory, so the service runs one instance. The visitor is the last `X-Forwarded-For` hop, which the client can't set. One transaction at a time per key.

Setup with [`scripts/testnet/try.ts`](scripts/testnet/try.ts):

- `try.ts setup`: accounts, contract, budget through a DAO vote, keys, one paid item. Keys go to `~/.near-credentials/testnet/earmark-try-keys.json`.
- `try.ts env`: writes the keys to `apps/web/.env.local` (gitignored) for `make web`.
- `try.ts scenes`: creates the race and paused budgets.
- `try.ts limits`: queues or applies the planned limits.
- `try.ts refill`: tops up the budget, the contract's storage NEAR and the signers' gas.

Public details are in [`fixtures/testnet-try.json`](fixtures/testnet-try.json).

### Testnet scripts

In [`scripts/testnet`](scripts/testnet):

- `demo.ts setup|history|close` creates the demo DAO, contract and budget, seeds the earlier payouts and refusals, and records each tx in `fixtures/`.
- `lock.ts` installs a new wasm through a DAO `UpgradeRemote` vote by the fixture's Admin members, records the code hash in the fixture and deletes the contract's keys.
- `settle.ts [request_id]` records the DAO's decision on escalated requests.
- `intents.ts setup|flow|delete` dry-runs near.com payouts on a throwaway contract (`intents-dev.earmark.testnet`) paying into a copy of the real Intents code (`earmark-intents-a.testnet`, fresh state): add a `0x…` payee, pay at once, pay after an approval, then pause the copy and see the payment fail with the money kept.
- `relay.ts account|carol|smoke <app>` makes the fee sponsor `gas.earmark.testnet`, makes `carol.earmark.testnet` (almost no NEAR) an approver of budget 0 by DAO vote, and relays one real request and approval through an app (`make relayer-account`, `make relay-smoke`). `relay.ts ask <app>` (`make relay-ask`) leaves one 10.5 tUSDC payment waiting for approval, to check a Telegram alert by hand.
- `tasks.ts setup|flow|delete` dry-runs tasks on a throwaway contract (`tasks-dev.earmark.testnet`, the owner account acts as the DAO): post, claim, send work, accept, then a trusted contributor paid without an approver. Not the demo contracts.

### Mainnet code update
The Admin's key stays in their wallet. [`scripts/mainnet/upgrade.ts`](scripts/mainnet/upgrade.ts) uses a one-time helper account, with its key on this machine only:
1. `upgrade.ts helper` makes the helper key and prints its address; send it about 4.4 NEAR.
2. `upgrade.ts store` sends the contract enough NEAR to keep 0.55 free after the bigger code, then stores the code in the DAO (`store_blob`, about 4.05 NEAR deposit).
3. The Admin opens `/update` in the app and signs twice: "Ask the council to update" (`UpgradeRemote`), then "Approve update" (300 Tgas). The page shows the running code, the new code and the vote.
4. `upgrade.ts finish` checks the new code runs, takes the blob deposit back (`remove_blob`) and deletes the helper, sending what's left to `omkar5.near`.

Rehearse first on a copy of the real mainnet state: `cargo test --test sandbox -- --ignored mainnet_upgrade_rehearsal` (needs internet and glibc 2.38, so run it in the `make test-sandbox` Docker image). It copies the contract's code, state and balance and the DAO's state, uses the DAO's exact Sputnik code, runs steps 2–4 and checks every budget, request and record reads the same afterwards.
- Older spikes: `OWNER=<you>.testnet scripts/testnet/s1-create-envelope.sh` creates a Sputnik DAO, deploys the contract and has the DAO create a budget; `s2-fund-envelope.sh` deploys the test token and has the DAO fund it; `s3-escalate.sh` sends a large request to a DAO vote; `s5-agent-key.sh` gives the spender a temporary key that can only call `request_spend` and shows every other call refused.

### Reproducible build

`cd contracts/earmark && cargo near build reproducible-wasm` (Docker; needs a clean, pushed commit). The contract's `contract_source_metadata` view links the commit it was built from and the pinned image (`build_environment`); its `build_command` shows the command run inside that image.

### Tests

Web unit tests: `pnpm --dir apps/web test` (Vitest): the relay's checks and the alerts' diff, wording and reminder.

`intents_payout` (sandbox, ignored by default, needs internet) runs a near.com payout against mainnet `intents.near`'s real code: paid at 100 Tgas, then refunded and failed cleanly while Intents is paused. `mainnet_upgrade_rehearsal` (sandbox, ignored by default) replays the mainnet code update on a copy of the live state. `check_spend_agrees_with_request_spend` runs 15 starting states × 8 amounts and asserts the view predicts exactly what `request_spend` does (tier or reason code). One difference stays by design: an unknown budget id is `closed` in the view and `unknown_envelope` in the call. See [Invariants](#invariants) for the rest.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml): rustfmt, clippy `-D warnings`, contract unit tests, biome and typecheck on every push to `main` and every pull request.

### Hosting

- Cloud Run service `earmark` in project `earmark-near-2026` (`us-central1`). Max 1 instance, scale to zero.
- Image from [`apps/web/Dockerfile`](apps/web/Dockerfile) (Next.js standalone output, Node 24, non-root), built by Cloud Build ([`apps/web/cloudbuild.yaml`](apps/web/cloudbuild.yaml)). The upload follows [`.gcloudignore`](.gcloudignore), so no `.env` file leaves the machine.
- The two sandbox keys are Secret Manager secrets `try-lead-key` and `try-council-key`, readable only by the service account `earmark-web`.
- Features 4 + 8 add Firestore (`(default)`, native, `us-central1`, free tier) for alert links, snapshots, message ids and relay counts. No money record lives there. They also add the secrets `relayer-key` (sponsor `gas.earmark.testnet`), `cron-secret`, `telegram-webhook-secret` and, once the bots exist, `telegram-token` / `telegram-token-mainnet`. `make deploy` passes only the secrets that exist, so a feature without its secret stays off. After a deploy with the bot token, `make alerts-setup [NET=mainnet]` sets the webhook and the every-minute Scheduler job.
- Mainnet: a second service `earmark-mainnet` from its own image, since `NEXT_PUBLIC_*` settings are compiled in at build time (`make deploy-mainnet`, passed as Docker build args). It has no sandbox keys; "Try it" links to the testnet app. It reads contract `budgets.omkar5.near` (0 keys, code hash `Gqnu9U…RjFz` from commit `faf4c31`), owned by the Trezu treasury `earmark.sputnik-dao.near`, with native USDC. Fund a new contract account with its storage (≈1 NEAR per 100 kB of wasm) plus 0.5 NEAR, the reserve below which it refuses new payments.

## License

[MIT](LICENSE)
