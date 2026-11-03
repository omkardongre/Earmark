# Earmark

## Development

Requirements: Rust (toolchain pinned in `rust-toolchain.toml`), [cargo-near](https://github.com/near/cargo-near), Node.js 24 and pnpm 10.

```sh
make install   # JS dependencies
make build     # contract WASM
make test      # contract tests
make lint      # rustfmt, clippy, biome
```

| Path | Contents |
|---|---|
| `contracts/earmark` | NEAR smart contract (Rust, near-sdk) |
| `contracts/test-token` | NEP-141 test stablecoin for testnet and sandbox (owner can mint) |
| `apps/web` | Web app (Next.js) |
| `scripts` | Node scripts for verification and rule preview |
| `scripts/testnet` | Testnet setup: `OWNER=<you>.testnet scripts/testnet/s1-create-envelope.sh` creates a Sputnik DAO, deploys the contract and has the DAO create a budget; `s2-fund-envelope.sh` deploys the test token and has the DAO fund it; `s3-escalate.sh` sends a large request to a DAO vote |

Testnet: contract `v2.earmark.testnet`, DAO `earmark-demo.sputnikv2.testnet`, token `tusdc.earmark.testnet`.
