# Earmark

## Development

Requirements: Rust (toolchain pinned in `rust-toolchain.toml`), [cargo-near](https://github.com/near/cargo-near), Node.js 24, pnpm 10 and Docker (sandbox tests).

```sh
make install   # JS dependencies
make build     # contract WASM
make test      # contract unit tests
make test-sandbox  # integration tests on a local NEAR node (Docker)
make lint      # rustfmt, clippy, biome
make verify    # check the live testnet deployment (no keys, no .env)
make demo      # replay the recorded testnet demo with tx links (no network)
make web       # web app on http://localhost:3000, reading the testnet demo
make web-build # production build of the web app
```

| Path | Contents |
|---|---|
| `contracts/earmark` | NEAR smart contract (Rust, near-sdk) |
| `contracts/test-token` | NEP-141 test stablecoin for testnet and sandbox (owner can mint) |
| `apps/web` | Web app (Next.js 16): budgets home with activity ("Show more" pages older history through `/api/activity`), budget page (payments table with filters and `list_requests` paging), payment page `/payments/[id]` (steps, each with its transaction), payment sheet with the tier shown before you send, approvals (shown only to approvers: approve, reject, "Recently decided" with when, and folded controls for waiting changes, pause with a confirm step, and raise), person page, and "Try your rules" (replays a mainnet Sputnik DAO's payout history against draft limits). Wallets via `@hot-labs/near-connect` (EVM wallets and NEAR CLI hidden); reads are public RPC; transactions found through the FastNEAR tx API (never cached). After a transaction the app reloads its data three times over ~7 s and screens update their own state, because the chain and the indexer lag and `router.refresh()` is unreliable on Next 16 ([vercel/next.js#99028](https://github.com/vercel/next.js/issues/99028)). Modal sheets close while the wallet asks, since a top-layer `<dialog>` would cover the wallet popup |
| `scripts` | Node scripts for verification and rule preview |
| `scripts/verify`, `scripts/demo` | `make verify`, `make demo`; both read `fixtures/testnet-demo.json` |
| `fixtures` | Every transaction of the recorded testnet demo, with its expected outcome |
| `scripts/testnet` | Testnet setup: `scripts/testnet/demo.ts setup|history|scenes|raise|close` seeds the demo and records each tx in `fixtures/`; `lock.ts` upgrades the contract through a DAO `UpgradeRemote` vote and deletes the contract's keys. Older spikes: `OWNER=<you>.testnet scripts/testnet/s1-create-envelope.sh` creates a Sputnik DAO, deploys the contract and has the DAO create a budget; `s2-fund-envelope.sh` deploys the test token and has the DAO fund it; `s3-escalate.sh` sends a large request to a DAO vote; `s5-agent-key.sh` gives the spender a temporary key that can only call `request_spend` and shows every other call refused |

## Contract methods

| Who | Methods |
|---|---|
| DAO (FunctionCall proposal) | `create_envelope`, `update_envelope` (any rule change), `close_envelope`; `upgrade` (new code, `UpgradeRemote` proposal); funds a budget with a Transfer proposal with `msg` (`ft_transfer_call`) |
| Spender (or its agent key) | `request_spend` |
| Approver | `approve`, `reject`, `override_duplicate`, `approve_payee`, `remove_payee`, `raise_limit`, `lower_limit`, `pause`, `unpause`, `cancel_change` |
| Anyone | `expire`, `apply_change`, views (`check_spend`, `get_envelope`, `list_requests`, `get_request`, `get_record`, `eligible`, `list_queued`, `get_change`) |

Changes that loosen a rule (raise a limit, add a payee, unpause, ...) are queued for `loosen_delay_secs` (120 s on testnet) and any approver or the DAO can cancel them. Changes that tighten apply at once.

Testnet: contract `v4.earmark.testnet` (no access keys: only a DAO vote can change its code), DAO `earmark-demo.sputnikv2.testnet`, token `tusdc.earmark.testnet`.
