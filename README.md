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
| Open [`/verify`](https://earmark-878141445235.us-central1.run.app/verify) ("Check it yourself") | Live, keyless checks: 0 access keys, the code hash matches the recorded build, code changes only by DAO vote, the DAO is the owner, balances add up. Each row links to NearBlocks and the raw RPC answer |
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
| Large payouts | Transfer proposal | Same: Earmark files the Transfer proposal (as a Requestor) and records the result |
| Who can be paid | Anyone the proposal names | Approved payees only; new payees wait out a delay |
| Overspending | Each proposal checked alone | Funds reserved at request; per-period cap per lead |
| Same work paid twice | Council must notice | Refused (`duplicate_work`) unless an approver overrides once |
| Contributor record | None | On-chain payee and lead records |
| Rule changes | A vote each | Tightening applies at once; loosening waits and can be cancelled |
| Code changes | n/a | Only by a DAO `UpgradeRemote` vote; the contract has 0 keys |

Sputnik pieces used: `FunctionCall` proposals (create, update, close a budget), Transfer with `msg` (fund a budget through `ft_transfer_call`), Transfer (escalation), `UpgradeRemote` (new code), the Requestor role, `get_policy` and `get_proposal`.

## Invariants

Each row names the test that checks it. Tests are in [`contracts/earmark/src/tests.rs`](contracts/earmark/src/tests.rs) (`make test`) and [`contracts/earmark/tests/sandbox.rs`](contracts/earmark/tests/sandbox.rs) (`make test-sandbox`).

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
| An escalation approved before an upgrade settles exactly once after it | tests.rs::escalation_from_before_the_upgrade_settles_once_after_it |
| Request 101 in a period: too_many_requests | tests.rs::request_cap_and_storage_float_block_new_requests |
| Removing the last approver who isn't that spender: refused | tests.rs::cannot_leave_a_spender_as_their_own_only_approver |
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
- **Trezu-shaped DAOs let a Requestor remove proposals.** In the policy Trezu gives new treasuries, a Requestor can remove pending proposals, including Earmark's escalations. `settle_escalation` then records the escalation as closed and frees the lead's slot.
- **Testnet only.** Nothing runs on mainnet. There is no proof yet that escalations render in Trezu: Trezu has no testnet, and the planned mainnet run did not happen.
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

Not done:

- Mainnet deployment and a Trezu rendering check.
- Audit.
- Wallet tests of the newest flows (payee registration, add payee, `/setup` filing).
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
| `make deploy-mainnet MAINNET_DAO=…` | The same for the mainnet app (`earmark-mainnet`) |
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
| DAO (FunctionCall proposal) | `create_envelope`, `update_envelope` (any rule change), `close_envelope`; `upgrade` (new code, `UpgradeRemote` proposal); funds a budget with a Transfer proposal with `msg` (`ft_transfer_call`) |
| Spender (or its agent key) | `request_spend` |
| Approver | `approve`, `reject`, `override_duplicate`, `approve_payee`, `remove_payee`, `raise_limit`, `lower_limit`, `pause`, `unpause`, `cancel_change` |
| Anyone | `expire`, `apply_change`, `settle_escalation`, views (`check_spend`, `get_envelope`, `list_requests`, `get_request`, `get_record`, `get_payee_record`, `eligible`, `list_queued`, `get_change`) |

Changes that loosen a rule (raise a limit, add a payee, unpause, ...) are queued for `loosen_delay_secs` (120 s on testnet) and any approver or the DAO can cancel them. Changes that tighten apply at once. `apply_change` refuses a queued change older than 14 days.

### Safety limits

- **Escalations settle.** `settle_escalation` reads the DAO proposal and records the result: approved → `paid_by_dao`; rejected, removed, expired or moved → `escalation_closed`. Both free the lead's DAO-vote slot (max 5 open). The payment page has a "Check the DAO result" button for this.
- **Request cap.** At most 100 requests per spender per budget period, and no new request while the contract has less than 0.5 NEAR free for storage.
- **Approvers.** Every spender keeps an approver other than themselves (`no_other_approver`).
- **Removal.** Removing a spender cancels their waiting changes and blocks approval of their pending requests.
- **Payee record.** `get_payee_record` counts confirmed payments to each payee, across budgets.
- **Escalation text.** DAO proposals use the format Trezu reads: `* Title: Earmark request <id> <br>* Notes: <memo> · by <spender> · budget <n> <br>* Url: <work link>`.
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
- **Budget page**: payments table with filters and `list_requests` paging; animated budget numbers (still with reduced motion); CSV export (`/api/export/<id>`: UTC date, request id, payee, exact amount, token, status, work link, tx; cells starting with `= + - @` are quoted against formula injection).
- **Payment page** `/payments/[id]`: steps, each with its transaction.
- **Payment sheet**: the tier shown before you send; a payee registration check (NEP-145 `storage_balance_of`; one-click `storage_deposit` with the deposit read from `storage_balance_bounds`), also used when an approver adds a payee.
- **Approvals**, shown only to approvers: approve, reject, "Recently decided" with when, and folded controls for waiting changes, pause with a confirm step, raise, and payees. "Add" a payee in one step: if the token doesn't know them yet, the same click pays their registration first (the wallet asks twice); the new payee shows in the list with its countdown and a "Make payable" button. The nav badge reloads its count (`/api/queue`) after each action.
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

Each row links to NearBlocks and the raw RPC answer (`/verify/rpc/<check>`). The expected DAO and code hash are in [`apps/web/src/lib/config.ts`](apps/web/src/lib/config.ts) (`EXPECTED_DAO`, `EXPECTED_CODE_HASH`; override with `NEXT_PUBLIC_DAO`, `NEXT_PUBLIC_CODE_HASH`). Update them when `lock.ts` installs new code.

### Set up a budget (`/setup`)

Enter the DAO and fill in one form: name, amount, period, leads and their limits, the one-approval limit, approvers (pre-filled from the DAO's Approver role, else its council) and who can be paid. The app reads `get_policy`, checks every account exists and the limits are consistent, and lists the DAO proposals it will file in plain words (people by name), with the exact `add_proposal` JSON and full accounts under Details. If the contract can't file DAO votes yet, the plan first adds it to the Requestor role (or a new role that can only file transfers). The connected wallet files the proposals. After the council approves the budget, the same page (its URL keeps the place) files the funding transfer. One contract serves one DAO.

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
- Older spikes: `OWNER=<you>.testnet scripts/testnet/s1-create-envelope.sh` creates a Sputnik DAO, deploys the contract and has the DAO create a budget; `s2-fund-envelope.sh` deploys the test token and has the DAO fund it; `s3-escalate.sh` sends a large request to a DAO vote; `s5-agent-key.sh` gives the spender a temporary key that can only call `request_spend` and shows every other call refused.

### Reproducible build

`cd contracts/earmark && cargo near build reproducible-wasm` (Docker; needs a clean, pushed commit). The contract's `contract_source_metadata` view links the commit it was built from and the pinned image (`build_environment`); its `build_command` shows the command run inside that image.

### Tests

`check_spend_agrees_with_request_spend` runs 15 starting states × 8 amounts and asserts the view predicts exactly what `request_spend` does (tier or reason code). One difference stays by design: an unknown budget id is `closed` in the view and `unknown_envelope` in the call. See [Invariants](#invariants) for the rest.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml): rustfmt, clippy `-D warnings`, contract unit tests, biome and typecheck on every push to `main` and every pull request.

### Hosting

- Cloud Run service `earmark` in project `earmark-near-2026` (`us-central1`). Max 1 instance, scale to zero.
- Image from [`apps/web/Dockerfile`](apps/web/Dockerfile) (Next.js standalone output, Node 24, non-root), built by Cloud Build ([`apps/web/cloudbuild.yaml`](apps/web/cloudbuild.yaml)). The upload follows [`.gcloudignore`](.gcloudignore), so no `.env` file leaves the machine.
- The two sandbox keys are Secret Manager secrets `try-lead-key` and `try-council-key`, readable only by the service account `earmark-web`.
- Mainnet: a second service `earmark-mainnet` from its own image, since `NEXT_PUBLIC_*` settings are compiled in at build time (`make deploy-mainnet MAINNET_DAO=<treasury>.sputnik-dao.near`, passed as Docker build args). It has no sandbox keys; "Try it" links to the testnet app.

## License

[MIT](LICENSE)
