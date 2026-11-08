# Earmark

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
```

Hosted demo: https://earmark-878141445235.us-central1.run.app (testnet).

| Path | Contents |
|---|---|
| `contracts/earmark` | NEAR smart contract (Rust, near-sdk) |
| `contracts/test-token` | NEP-141 test stablecoin for testnet and sandbox (owner can mint) |
| `apps/web` | Web app (Next.js 16): budgets home with activity ("Show more" pages older history through `/api/activity`), budget page (payments table with filters and `list_requests` paging), payment page `/payments/[id]` (steps, each with its transaction), payment sheet with the tier shown before you send, approvals (shown only to approvers: approve, reject, "Recently decided" with when, and folded controls for waiting changes, pause with a confirm step, and raise), People board `/people` (contributor and lead records from the contract) and person page, a landing intro for signed-out visitors (one line, live counts per payment path with the latest of each, links to Try it and the replay), "Try it" `/try` (below), and "Try your rules" (replays a mainnet Sputnik DAO's payout history against draft limits). Wallets via `@hot-labs/near-connect` (EVM wallets and NEAR CLI hidden); reads are public RPC; transactions found through the FastNEAR tx API (never cached). After a transaction the app reloads its data three times over ~7 s and screens update their own state, because the chain and the indexer lag and `router.refresh()` is unreliable on Next 16 ([vercel/next.js#99028](https://github.com/vercel/next.js/issues/99028)). Modal sheets close while the wallet asks, since a top-layer `<dialog>` would cover the wallet popup |
| `scripts` | Node scripts for verification and rule preview |
| `scripts/verify`, `scripts/demo` | `make verify`, `make demo`; both read `fixtures/testnet-demo.json` |
| `fixtures` | Every transaction of the recorded testnet demo, with its expected outcome |
| `scripts/testnet` | Testnet setup: `scripts/testnet/demo.ts setup|history|close` creates the demo DAO, contract and budget, seeds the earlier payouts and refusals, and records each tx in `fixtures/`; `lock.ts` installs a new wasm through a DAO `UpgradeRemote` vote by the fixture's Admin members, records the code hash in the fixture and deletes the contract's keys; `settle.ts [request_id]` records the DAO's decision on escalated requests. Older spikes: `OWNER=<you>.testnet scripts/testnet/s1-create-envelope.sh` creates a Sputnik DAO, deploys the contract and has the DAO create a budget; `s2-fund-envelope.sh` deploys the test token and has the DAO fund it; `s3-escalate.sh` sends a large request to a DAO vote; `s5-agent-key.sh` gives the spender a temporary key that can only call `request_spend` and shows every other call refused |

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

`/try` lets a visitor drive a separate sandbox contract, `try.earmark.testnet` (same code, no access keys, owned by the demo DAO; budget 0 "Try it": auto limit 5, one approval up to 25, 1-hour period, 10-minute approval window). The server signs with two testnet function-call keys: `try-lead.earmark.testnet` can only call `request_spend`, `try-council.earmark.testnet` only `approve` and `expire`, both only on the sandbox contract. Visitors choose a scene (pay 3, ask 20 then approve, pay an unknown account, pay the same work twice, use the lead's key to approve); they never send amounts or payees. `/api/try` allows 20 actions per visitor and 300 in total per 10 minutes (in memory, so the service runs one instance), and one transaction at a time per key.

Setup: `scripts/testnet/try.ts setup` (accounts, contract, budget through a DAO vote, keys, one paid item; keys go to `~/.near-credentials/testnet/earmark-try-keys.json`), `try.ts env` writes them to `apps/web/.env.local` (gitignored) for `make web`, `try.ts refill` tops up the budget, the contract's storage NEAR and the signers' gas. Public details are in `fixtures/testnet-try.json`.

## Hosting

Cloud Run service `earmark` in project `earmark-near-2026` (`us-central1`), image from `apps/web/Dockerfile` (Next.js standalone output, Node 24, non-root) built by Cloud Build (`apps/web/cloudbuild.yaml`; the upload follows `.gcloudignore`, so no `.env` file leaves the machine). The two sandbox keys are Secret Manager secrets `try-lead-key` and `try-council-key`, readable only by the service account `earmark-web`. Max 1 instance, scale to zero.

Reproducible build: `cd contracts/earmark && cargo near build reproducible-wasm` (Docker; needs a clean, pushed commit). The contract's `contract_source_metadata` view links the commit it was built from.
