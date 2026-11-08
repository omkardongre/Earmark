# Earmark
[![CI](https://github.com/omkardongre/Earmark/actions/workflows/ci.yml/badge.svg)](https://github.com/omkardongre/Earmark/actions/workflows/ci.yml)

## Development

Requirements: Rust (toolchain pinned in `rust-toolchain.toml`), [cargo-near](https://github.com/near/cargo-near), Node.js 24, pnpm 10 and Docker (sandbox tests).

```sh
make install   # JS dependencies
make build     # contract WASM
make test      # contract unit tests
make test-sandbox  # integration tests on a local NEAR node (Docker)
make lint      # rustfmt, clippy, biome
make verify    # check the live testnet deployment (no keys, no .env; tx lookups use archival RPC)
make demo      # replay the recorded testnet demo with tx links (no network)
make web       # web app on http://localhost:3000, reading the testnet demo
make web-build # production build of the web app
make deploy    # build on Cloud Build and deploy to Cloud Run
make try-refill # top up the "Try it" sandbox
make try-scenes # create the race and paused sandbox budgets (idempotent)
make try-limits # move the sandbox to 5 at once / 50 with one approval (DAO vote, then the 1-day delay)
```

Hosted demo: https://earmark-878141445235.us-central1.run.app (testnet).

| Path | Contents |
|---|---|
| `contracts/earmark` | NEAR smart contract (Rust, near-sdk) |
| `contracts/test-token` | NEP-141 test stablecoin for testnet and sandbox (owner can mint) |
| `apps/web` | Web app (Next.js 16): budgets home with activity ("Show more" pages older history through `/api/activity`), budget page (payments table with filters and `list_requests` paging), payment page `/payments/[id]` (steps, each with its transaction), payment sheet with the tier shown before you send, approvals (shown only to approvers: approve, reject, "Recently decided" with when, and folded controls for waiting changes, pause with a confirm step, and raise), People board `/people` (contributor and lead records from the contract) and person page, a landing intro for signed-out visitors (one line, live counts per payment path with the latest of each, links to Try it and the replay), "Try it" `/try` (below), "Try your rules" (replays a mainnet Sputnik DAO's payout history against draft limits), a route picker on the landing (amount + payee → pays now / one approval / DAO vote / blocked, from the live `check_spend` view, no wallet), `/verify` (below), `/setup` (below), CSV export of a budget's payments (`/api/export/<id>`: UTC date, request id, payee, exact amount, token, status, work link, tx; cells starting with `= + - @` are quoted against formula injection), animated budget numbers (still with reduced motion), and a payee registration check (NEP-145 `storage_balance_of`; one-click `storage_deposit` with the deposit read from `storage_balance_bounds`) in the pay sheet and when an approver adds a payee. Reads try each RPC in `RPC_URLS` (FastNEAR, then near.org) and, on the server, fall back to the last good value with a "showing values from <time>" notice. Wallets via `@hot-labs/near-connect` (EVM wallets and NEAR CLI hidden); reads are public RPC; transactions found through the FastNEAR tx API (never cached). After a transaction the app reloads its data three times over ~7 s and screens update their own state, because the chain and the indexer lag and `router.refresh()` is unreliable on Next 16 ([vercel/next.js#99028](https://github.com/vercel/next.js/issues/99028)). Modal sheets close while the wallet asks, since a top-layer `<dialog>` would cover the wallet popup |
| `scripts` | Node scripts for verification and rule preview |
| `scripts/verify`, `scripts/demo` | `make verify`, `make demo`; both read `fixtures/testnet-demo.json` |
| `fixtures` | Every transaction of the recorded testnet demo, with its expected outcome |
| `scripts/testnet` | Testnet setup: `scripts/testnet/demo.ts setup|history|close` creates the demo DAO, contract and budget, seeds the earlier payouts and refusals, and records each tx in `fixtures/`; `lock.ts` installs a new wasm through a DAO `UpgradeRemote` vote by the fixture's Admin members, records the code hash in the fixture and deletes the contract's keys; `settle.ts [request_id]` records the DAO's decision on escalated requests. Older spikes: `OWNER=<you>.testnet scripts/testnet/s1-create-envelope.sh` creates a Sputnik DAO, deploys the contract and has the DAO create a budget; `s2-fund-envelope.sh` deploys the test token and has the DAO fund it; `s3-escalate.sh` sends a large request to a DAO vote; `s5-agent-key.sh` gives the spender a temporary key that can only call `request_spend` and shows every other call refused |

## Check it yourself (`/verify`)
Live, keyless checks of `budgets.earmark.testnet`, the browser version of `make verify`: 0 access keys; the code hash matches the recorded reproducible build and `contract_source_metadata` names the commit and the pinned Docker image; code changes only by DAO `UpgradeRemote` votes (the contract deployed itself once, then deleted its key; no upgrade since); the DAO is the owner; balances add up (token held ≥ budgets, balance = available + waiting + paying, paid requests = paid out). Each row links to NearBlocks and the raw RPC answer (`/verify/rpc/<check>`). The expected DAO and code hash are in `apps/web/src/lib/config.ts` (`NEXT_PUBLIC_DAO`, `NEXT_PUBLIC_CODE_HASH`); update them when `lock.ts` installs new code.
## Set up a budget (`/setup`)
Enter the DAO and fill in one form: name, amount, period, leads and their limits, the one-approval limit, approvers (pre-filled from the DAO's Approver role, else its council) and who can be paid. The app reads `get_policy`, checks every account exists and the limits are consistent, and lists the DAO proposals it will file in plain words, with the exact `add_proposal` JSON under Details. If the contract can't file DAO votes yet, the plan first adds it to the Requestor role (or a new role that can only file transfers). The connected wallet files the proposals; after the council approves the budget, the same page (its URL keeps the place) files the funding transfer. One contract serves one DAO.
## Contract methods

| Who | Methods |
|---|---|
| DAO (FunctionCall proposal) | `create_envelope`, `update_envelope` (any rule change), `close_envelope`; `upgrade` (new code, `UpgradeRemote` proposal); funds a budget with a Transfer proposal with `msg` (`ft_transfer_call`) |
| Spender (or its agent key) | `request_spend` |
| Approver | `approve`, `reject`, `override_duplicate`, `approve_payee`, `remove_payee`, `raise_limit`, `lower_limit`, `pause`, `unpause`, `cancel_change` |
| Anyone | `expire`, `apply_change`, `settle_escalation`, views (`check_spend`, `get_envelope`, `list_requests`, `get_request`, `get_record`, `get_payee_record`, `eligible`, `list_queued`, `get_change`) |

Changes that loosen a rule (raise a limit, add a payee, unpause, ...) are queued for `loosen_delay_secs` (120 s on testnet) and any approver or the DAO can cancel them. Changes that tighten apply at once.

Safety limits:

- **Escalations settle.** `settle_escalation` reads the DAO proposal and records the result: approved → `paid_by_dao`; rejected, removed, expired or moved → `escalation_closed`. Both free the lead's DAO-vote slot (max 5 open). The payment page has a "Check the DAO result" button for this.
- **Request cap.** At most 100 requests per spender per budget period, and no new request while the contract has less than 0.5 NEAR free for storage.
- **Approvers.** Every spender keeps an approver other than themselves (`no_other_approver`).
- **Removal.** Removing a spender cancels their waiting changes and blocks approval of their pending requests.
- **Payee record.** `get_payee_record` counts confirmed payments to each payee, across budgets.
- **Escalation text.** DAO proposals use the format Trezu reads: `* Title: Earmark request <id> <br>* Notes: <memo> · by <spender> · budget <n> <br>* Url: <work link>`.
- **Upgrades.** `migrate` converts the state layout from before these limits, so the live contract can be upgraded through a DAO vote.

Testnet demo: contract `budgets.earmark.testnet` (reproducible build, no access keys: only a DAO vote can change its code), DAO `community-news.sputnikv2.testnet` with the policy Trezu gives new treasuries (Requestor / Admin / Approver, 2 of 3 council votes, bond 0; the contract is a Requestor so it can file escalations), token `tusdc.earmark.testnet`. Budget 0 "News contributors": leads Maya and Theo, council Priya, Daniel and Lena, contributors Sofia, Kenji and Ana. The earlier deployment (`v4.earmark.testnet`, DAO `earmark-demo.sputnikv2.testnet`) stays readable; its fixture is in `fixtures/archive/`.

## Try it (no wallet)

`/try` lets a visitor drive a separate sandbox contract, `try.earmark.testnet` (same code, no access keys, owned by the demo DAO; budget 0 "Try it": auto limit 5, one approval up to 25, 1-hour period, 10-minute approval window). The server signs with two testnet function-call keys: `try-lead.earmark.testnet` can only call `request_spend`, `try-council.earmark.testnet` only `approve` and `expire`, both only on the sandbox contract. Visitors choose a scene; they never send amounts or payees. `/api/try` allows 20 actions per visitor and 300 in total per 10 minutes (the race counts as 2; in memory, so the service runs one instance; the visitor is the last `X-Forwarded-For` hop, which the client can't set), and one transaction at a time per key.

Setup: `scripts/testnet/try.ts setup` (accounts, contract, budget through a DAO vote, keys, one paid item; keys go to `~/.near-credentials/testnet/earmark-try-keys.json`), `try.ts env` writes them to `apps/web/.env.local` (gitignored) for `make web`, `try.ts scenes` creates the race and paused budgets, `try.ts limits` queues or applies the planned limits, `try.ts refill` tops up the budget, the contract's storage NEAR and the signers' gas. Public details are in `fixtures/testnet-try.json`.

## Hosting

Cloud Run service `earmark` in project `earmark-near-2026` (`us-central1`), image from `apps/web/Dockerfile` (Next.js standalone output, Node 24, non-root) built by Cloud Build (`apps/web/cloudbuild.yaml`; the upload follows `.gcloudignore`, so no `.env` file leaves the machine). The two sandbox keys are Secret Manager secrets `try-lead-key` and `try-council-key`, readable only by the service account `earmark-web`. Max 1 instance, scale to zero.

Reproducible build: `cd contracts/earmark && cargo near build reproducible-wasm` (Docker; needs a clean, pushed commit). The contract's `contract_source_metadata` view links the commit it was built from and the pinned image (`build_environment`); its `build_command` shows the command run inside that image.

CI (`.github/workflows/ci.yml`): rustfmt, clippy `-D warnings`, contract unit tests, biome and typecheck on every push to `main` and every pull request.

Tests: `check_spend_agrees_with_request_spend` runs 15 starting states × 8 amounts and asserts the view predicts exactly what `request_spend` does (tier or reason code). One difference stays by design: an unknown budget id is `closed` in the view and `unknown_envelope` in the call.
