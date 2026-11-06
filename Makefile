.PHONY: install build test test-sandbox lint fmt verify demo web web-build

# The sandbox node needs glibc >= 2.38; this image has it on any host with Docker.
SANDBOX_IMAGE ?= rust:1.97.1-trixie

TSX = scripts/node_modules/.bin/tsx

install:
	pnpm install --frozen-lockfile

build:
	cd contracts/test-token && cargo near build non-reproducible-wasm
	cd contracts/earmark && cargo near build non-reproducible-wasm

test:
	cargo test --workspace --lib

test-sandbox: build
	docker run --rm -u $$(id -u):$$(id -g) -e HOME=/tmp/home -e CARGO_HOME=/tmp/home/.cargo \
		-e CARGO_TARGET_DIR=/work/target/docker -v "$$PWD":/work \
		-v $$HOME/.cargo/registry:/tmp/home/.cargo/registry -w /work $(SANDBOX_IMAGE) \
		cargo test -p earmark --test sandbox

lint:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	pnpm lint

fmt:
	cargo fmt --all
	pnpm format

# Keyless checks of the live testnet deployment (public RPC reads only).
verify:
	$(TSX) scripts/verify/verify.ts

# Replays the recorded testnet demo from fixtures/ (no keys, no network).
demo:
	$(TSX) scripts/demo/demo.ts

# Web app on http://localhost:3000 (testnet demo by default; see apps/web/.env.example).
web:
	pnpm --dir apps/web dev

web-build:
	pnpm --dir apps/web build
