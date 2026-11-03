.PHONY: install build test test-sandbox lint fmt

# The sandbox node needs glibc >= 2.38; this image has it on any host with Docker.
SANDBOX_IMAGE ?= rust:1.97.1-trixie

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
