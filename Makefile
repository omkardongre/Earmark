.PHONY: install build test lint fmt

install:
	pnpm install --frozen-lockfile

build:
	cd contracts/earmark && cargo near build non-reproducible-wasm

test:
	cargo test --workspace

lint:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	pnpm lint

fmt:
	cargo fmt --all
	pnpm format
