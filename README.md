# Earmark

## Development

Requirements: Rust (toolchain pinned in `rust-toolchain.toml`), [cargo-near](https://github.com/near/cargo-near), Node.js 24, pnpm 10 and Docker (sandbox tests).

```sh
make install   # JS dependencies
make build     # contract WASM
make test      # contract unit tests
make test-sandbox  # integration tests on a local NEAR node (Docker)
make lint      # rustfmt, clippy, biome
```

| Path | Contents |
|---|---|
| `contracts/earmark` | NEAR smart contract (Rust, near-sdk) |
| `contracts/test-token` | NEP-141 test stablecoin for testnet and sandbox (owner can mint) |
| `apps/web` | Web app (Next.js) |
| `scripts` | Node scripts for verification and rule preview |
| `scripts/testnet` | Testnet setup: `OWNER=<you>.testnet scripts/testnet/s1-create-envelope.sh` creates a Sputnik DAO, deploys the contract and has the DAO create a budget; `s2-fund-envelope.sh` deploys the test token and has the DAO fund it; `s3-escalate.sh` sends a large request to a DAO vote; `s5-agent-key.sh` gives the spender a temporary key that can only call `request_spend` and shows every other call refused |

## Contract methods

| Who | Methods |
|---|---|
| DAO (FunctionCall proposal) | `create_envelope`, `update_envelope` (any rule change), `close_envelope`; funds a budget with a Transfer proposal with `msg` (`ft_transfer_call`) |
| Spender (or its agent key) | `request_spend` |
| Approver | `approve`, `reject`, `override_duplicate`, `approve_payee`, `remove_payee`, `raise_limit`, `lower_limit`, `pause`, `unpause`, `cancel_change` |
| Anyone | `expire`, `apply_change`, views (`check_spend`, `get_envelope`, `get_request`, `get_record`, `eligible`, `list_queued`, `get_change`) |

Changes that loosen a rule (raise a limit, add a payee, unpause, ...) are queued for `loosen_delay_secs` (120 s on testnet) and any approver or the DAO can cancel them. Changes that tighten apply at once.

Testnet: contract `v3.earmark.testnet`, DAO `earmark-demo.sputnikv2.testnet`, token `tusdc.earmark.testnet`.
