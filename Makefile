.PHONY: install build test test-sandbox lint fmt verify demo web web-build deploy deploy-mainnet try-refill try-scenes try-limits

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

# Hosted app on Cloud Run (gcloud config `earmark`). The two "Try it" keys come from Secret
# Manager (try-lead-key, try-council-key); see README "Hosting".
GCP_PROJECT ?= earmark-near-2026
GCP_REGION ?= us-central1
IMAGE = $(GCP_REGION)-docker.pkg.dev/$(GCP_PROJECT)/earmark/web:$(shell git rev-parse --short HEAD)

deploy:
	gcloud builds submit --project=$(GCP_PROJECT) --config apps/web/cloudbuild.yaml \
		--substitutions=_TAG=$(shell git rev-parse --short HEAD),_REGION=$(GCP_REGION)
	gcloud run deploy earmark --project=$(GCP_PROJECT) --region=$(GCP_REGION) --image=$(IMAGE) \
		--service-account=earmark-web@$(GCP_PROJECT).iam.gserviceaccount.com --allow-unauthenticated \
		--port=8080 --cpu=1 --memory=512Mi --concurrency=40 --min-instances=0 --max-instances=1 \
		--set-env-vars=TRY_CONTRACT=try.earmark.testnet,TRY_LEAD_ACCOUNT=try-lead.earmark.testnet,TRY_COUNCIL_ACCOUNT=try-council.earmark.testnet \
		--set-secrets=TRY_LEAD_KEY=try-lead-key:latest,TRY_COUNCIL_KEY=try-council-key:latest

# Mainnet app: its own image (public settings are compiled in) and service, no "Try it" keys.
MAINNET_CONTRACT ?= budgets.omkar5.near
MAINNET_DAO ?= earmark.sputnik-dao.near
MAINNET_CODE_HASH ?= Gqnu9UMKSJYiaZU97iC6cQQwnmxmSvjuUhHDEDnHRjFz
MAINNET_TAG = mainnet-$(shell git rev-parse --short HEAD)
deploy-mainnet:
	@test -n "$(MAINNET_DAO)" || (echo "Set MAINNET_DAO=<treasury>.sputnik-dao.near" && exit 1)
	gcloud builds submit --project=$(GCP_PROJECT) --config apps/web/cloudbuild.yaml \
		--substitutions=_TAG=$(MAINNET_TAG),_REGION=$(GCP_REGION),_NETWORK=mainnet,_CONTRACT=$(MAINNET_CONTRACT),_DAO=$(MAINNET_DAO),_CODE_HASH=$(MAINNET_CODE_HASH)
	gcloud run deploy earmark-mainnet --project=$(GCP_PROJECT) --region=$(GCP_REGION) \
		--image=$(GCP_REGION)-docker.pkg.dev/$(GCP_PROJECT)/earmark/web:$(MAINNET_TAG) \
		--service-account=earmark-web@$(GCP_PROJECT).iam.gserviceaccount.com --allow-unauthenticated \
		--port=8080 --cpu=1 --memory=512Mi --concurrency=40 --min-instances=0 --max-instances=1
# Tops up the "Try it" sandbox (budget, storage NEAR, signer gas).
try-refill:
	$(TSX) scripts/testnet/try.ts refill

# The race and paused sandbox budgets (once; safe to run again).
try-scenes:
	$(TSX) scripts/testnet/try.ts scenes

# Budget 0 to 5 paid at once / 50 with one approval: queues the change, then applies it a day later.
try-limits:
	$(TSX) scripts/testnet/try.ts limits
