.PHONY: install build test test-sandbox lint fmt verify trezu-check judge-check attacks demo web web-build deploy deploy-mainnet alerts-setup relayer-account relay-smoke relay-ask try-refill try-scenes try-limits

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
# make verify (testnet) or make verify NET=mainnet. PASS / FAIL / WARN per check; exit = failures.
verify:
	$(TSX) scripts/verify/verify.ts --network $(or $(NET),testnet)

# Validates the Trezu forms in trezu/ with Trezu's own validator and the contract's argument shapes.
trezu-check:
	$(TSX) scripts/trezu/check.ts

# Every label JUDGE.md tells a judge to press must still exist in the app.
judge-check:
	$(TSX) scripts/judge/check.ts

# Sends calls that must be refused on the testnet demo budget and records each refused tx in
# fixtures/testnet-attacks.json, which make verify re-reads (needs maya's key; no money moves).
attacks:
	$(TSX) scripts/testnet/attacks.ts

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
# Image tag: the commit, plus "-dirty-<time>" when the tree has uncommitted changes, so a test
# deploy never overwrites a commit's image.
TAG := $(shell git rev-parse --short HEAD)$(shell git diff --quiet HEAD || date +-dirty-%m%d%H%M)
IMAGE = $(GCP_REGION)-docker.pkg.dev/$(GCP_PROJECT)/earmark/web:$(TAG)
TESTNET_APP ?= https://earmark-878141445235.us-central1.run.app
MAINNET_APP ?= https://earmark-mainnet-878141445235.us-central1.run.app
# Features 4 + 8 (docs/05): Firestore keeps alert links and relay counts; secrets come from
# Secret Manager. A secret that doesn't exist yet (the bot token before the bot is made) is left
# out, and that feature stays off.
has_secret = $(shell gcloud secrets describe $(1) --project=$(GCP_PROJECT) >/dev/null 2>&1 && echo yes)
opt_secret = $(if $(call has_secret,$(2)),$(1)=$(2):latest,)
join_comma = $(subst $(eval) ,$(comma),$(strip $(1)))
comma := ,

deploy:
	gcloud builds submit --project=$(GCP_PROJECT) --config apps/web/cloudbuild.yaml \
		--substitutions=_TAG=$(TAG),_REGION=$(GCP_REGION)
	gcloud run deploy earmark --project=$(GCP_PROJECT) --region=$(GCP_REGION) --image=$(IMAGE) \
		--service-account=earmark-web@$(GCP_PROJECT).iam.gserviceaccount.com --allow-unauthenticated \
		--port=8080 --cpu=1 --memory=512Mi --concurrency=40 --min-instances=0 --max-instances=1 \
		--set-env-vars=TRY_CONTRACT=try.earmark.testnet,TRY_LEAD_ACCOUNT=try-lead.earmark.testnet,TRY_COUNCIL_ACCOUNT=try-council.earmark.testnet,FIRESTORE=1,APP_URL=$(TESTNET_APP),RELAYER_ACCOUNT=gas.earmark.testnet,TELEGRAM_BOT=$(TESTNET_BOT) \
		--set-secrets=$(call join_comma,TRY_LEAD_KEY=try-lead-key:latest TRY_COUNCIL_KEY=try-council-key:latest $(call opt_secret,RELAYER_KEY,relayer-key) $(call opt_secret,CRON_SECRET,cron-secret) $(call opt_secret,TELEGRAM_WEBHOOK_SECRET,telegram-webhook-secret) $(call opt_secret,TELEGRAM_TOKEN,telegram-token))

# Mainnet app: its own image (public settings are compiled in) and service, no "Try it" keys.
MAINNET_CONTRACT ?= budgets.omkar5.near
MAINNET_DAO ?= earmark.sputnik-dao.near
MAINNET_CODE_HASH ?= DGwhd93GKEFkozGiNxFqqusx5fTXMQ9qrwMeErnoUGrx
MAINNET_TAG = mainnet-$(TAG)
deploy-mainnet:
	@test -n "$(MAINNET_DAO)" || (echo "Set MAINNET_DAO=<treasury>.sputnik-dao.near" && exit 1)
	gcloud builds submit --project=$(GCP_PROJECT) --config apps/web/cloudbuild.yaml \
		--substitutions=_TAG=$(MAINNET_TAG),_REGION=$(GCP_REGION),_NETWORK=mainnet,_CONTRACT=$(MAINNET_CONTRACT),_DAO=$(MAINNET_DAO),_CODE_HASH=$(MAINNET_CODE_HASH)
	gcloud run deploy earmark-mainnet --project=$(GCP_PROJECT) --region=$(GCP_REGION) \
		--image=$(GCP_REGION)-docker.pkg.dev/$(GCP_PROJECT)/earmark/web:$(MAINNET_TAG) \
		--service-account=earmark-web@$(GCP_PROJECT).iam.gserviceaccount.com --allow-unauthenticated \
		--port=8080 --cpu=1 --memory=512Mi --concurrency=40 --min-instances=0 --max-instances=1 \
		--set-env-vars=FIRESTORE=1,APP_URL=$(MAINNET_APP),RELAYER_ACCOUNT=gas.omkar5.near,TELEGRAM_BOT=$(MAINNET_BOT) \
		$(if $(strip $(MAINNET_SECRETS)),--set-secrets=$(call join_comma,$(MAINNET_SECRETS)),)
MAINNET_SECRETS = $(call opt_secret,RELAYER_KEY,relayer-key-mainnet) $(call opt_secret,CRON_SECRET,cron-secret) $(call opt_secret,TELEGRAM_WEBHOOK_SECRET,telegram-webhook-secret) $(call opt_secret,TELEGRAM_TOKEN,telegram-token-mainnet)

# Telegram bots (one per app: a bot has one webhook). Pick the names in @BotFather.
TESTNET_BOT ?= EarmarkTestnetBot
MAINNET_BOT ?= EarmarkBot
# Points the bot at the app and runs the alerts watcher every minute (docs/05 §8). Run after a
# deploy that has the bot token: make alerts-setup [NET=mainnet].
NET ?= testnet
alerts-setup:
	@APP=$(if $(filter mainnet,$(NET)),$(MAINNET_APP),$(TESTNET_APP)); \
	TOKEN_SECRET=$(if $(filter mainnet,$(NET)),telegram-token-mainnet,telegram-token); \
	TOKEN=$$(gcloud secrets versions access latest --secret=$$TOKEN_SECRET --project=$(GCP_PROJECT)); \
	HOOK=$$(gcloud secrets versions access latest --secret=telegram-webhook-secret --project=$(GCP_PROJECT)); \
	CRON=$$(gcloud secrets versions access latest --secret=cron-secret --project=$(GCP_PROJECT)); \
	curl -s "https://api.telegram.org/bot$$TOKEN/setWebhook" --data-urlencode "url=$$APP/api/telegram" \
		--data-urlencode "secret_token=$$HOOK" --data-urlencode 'allowed_updates=["message","my_chat_member"]' \
		--data-urlencode "drop_pending_updates=true"; echo; \
	JOB=alerts-$(NET); \
	if gcloud scheduler jobs describe $$JOB --location=$(GCP_REGION) --project=$(GCP_PROJECT) >/dev/null 2>&1; then OP=update; else OP=create; fi; \
	gcloud scheduler jobs $$OP http $$JOB --location=$(GCP_REGION) --project=$(GCP_PROJECT) \
		--schedule="* * * * *" --uri="$$APP/api/cron/alerts" --http-method=POST \
		--$$( [ $$OP = create ] && echo headers || echo update-headers )="x-cron-secret=$$CRON" \
		--attempt-deadline=60s --max-retry-attempts=0 >/dev/null && echo "scheduler $$JOB: every minute"

# Fees paid by Earmark (feature 8): makes the testnet sponsor gas.earmark.testnet, and relays
# one real request + approval through an app's /api/relay (APP=http://localhost:3005 or hosted).
relayer-account:
	$(TSX) scripts/testnet/relay.ts account
relay-smoke:
	$(TSX) scripts/testnet/relay.ts smoke $(or $(APP),$(TESTNET_APP))
# One payment over maya's limit, left waiting for approval: checks a Telegram alert by hand.
relay-ask:
	$(TSX) scripts/testnet/relay.ts ask $(or $(APP),$(TESTNET_APP))

# Tops up the "Try it" sandbox (budget, storage NEAR, signer gas).
try-refill:
	$(TSX) scripts/testnet/try.ts refill

# The race and paused sandbox budgets (once; safe to run again).
try-scenes:
	$(TSX) scripts/testnet/try.ts scenes

# Budget 0 to 5 paid at once / 50 with one approval: queues the change, then applies it a day later.
try-limits:
	$(TSX) scripts/testnet/try.ts limits
