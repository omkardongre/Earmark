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
| `apps/web` | Web app (Next.js) |
| `scripts` | Node scripts for verification and rule preview |
