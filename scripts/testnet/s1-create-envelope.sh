#!/usr/bin/env bash
# Creates a test Sputnik DAO, deploys the Earmark contract and has the DAO create a budget
# through a FunctionCall proposal. Testnet only. Keys come from ~/.near-credentials.
set -euo pipefail

: "${OWNER:?set OWNER, e.g. earmark.testnet}"
NETWORK=testnet
FACTORY=sputnikv2.testnet
DAO_NAME=${DAO_NAME:-earmark-demo}
DAO="$DAO_NAME.$FACTORY"
CONTRACT=${CONTRACT:-v2.$OWNER}
TOKEN=${TOKEN:-tusdc.$OWNER}
LOOSEN_DELAY_SECS=${LOOSEN_DELAY_SECS:-120}
WASM=${WASM:-target/near/earmark/earmark.wasm}

rpc() {
  curl -sS -m 20 "https://rpc.$NETWORK.fastnear.com" -H 'Content-Type: application/json' -d "$1"
}
view() { # view <account> <method> <json-args>
  local args
  args=$(printf '%s' "$3" | base64 -w0)
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args\"}}" |
    python3 -c 'import sys,json; r=json.load(sys.stdin); print(bytes(r["result"]["result"]).decode()) if "result" in r and "result" in r["result"] else sys.exit("view failed: %s" % r)'
}
exists() {
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | grep -q '"amount"'
}
call() { # call <signer> <contract> <method> <json-args> <gas> <deposit>
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "$5" attached-deposit "$6" sign-as "$1" \
    network-config "$NETWORK" sign-with-legacy-keychain send
}

echo "1. DAO $DAO (council: $OWNER)"
if ! exists "$DAO"; then
  dao_args=$(printf '{"config":{"name":"%s","purpose":"Earmark test DAO","metadata":""},"policy":["%s"]}' "$DAO_NAME" "$OWNER" | base64 -w0)
  call "$OWNER" "$FACTORY" create "{\"name\":\"$DAO_NAME\",\"args\":\"$dao_args\"}" '150 Tgas' '6 NEAR'
fi

echo "2. Contract $CONTRACT"
if ! exists "$CONTRACT"; then
  near account create-account fund-myself "$CONTRACT" '5 NEAR' autogenerate-new-keypair \
    --signature-scheme ed25519 save-to-legacy-keychain sign-as "$OWNER" \
    network-config "$NETWORK" sign-with-legacy-keychain send
  near contract deploy "$CONTRACT" use-file "$WASM" with-init-call new \
    json-args "{\"dao_id\":\"$DAO\",\"token_ids\":[\"$TOKEN\"],\"loosen_delay_secs\":\"$LOOSEN_DELAY_SECS\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi

echo "3. Proposal: DAO calls create_envelope"
policy=$(view "$DAO" get_policy '{}')
bond=$(printf '%s' "$policy" | python3 -c 'import sys,json; print(json.load(sys.stdin)["proposal_bond"])')
envelope=$(printf '{"envelope":{"name":"News team","token_id":"%s","spenders":[{"account_id":"%s","auto_limit":"10000000","period_cap":"200000000"}],"approvers":["%s"],"one_approver_limit":"50000000","raise_ceiling":"25000000","payees":["%s"],"period_secs":"2592000","period_cap":"500000000"}}' \
  "$TOKEN" "$OWNER" "$OWNER" "$OWNER")
envelope_b64=$(printf '%s' "$envelope" | base64 -w0)
storage_deposit=100000000000000000000000 # 0.1 NEAR; unused part is refunded to the DAO
proposal=$(printf '{"proposal":{"description":"Create Earmark budget: News team","kind":{"FunctionCall":{"receiver_id":"%s","actions":[{"method_name":"create_envelope","args":"%s","deposit":"%s","gas":"50000000000000"}]}}}}' \
  "$CONTRACT" "$envelope_b64" "$storage_deposit")
call "$OWNER" "$DAO" add_proposal "$proposal" '50 Tgas' "$bond yoctoNEAR"
proposal_id=$(( $(view "$DAO" get_last_proposal_id '{}') - 1 ))
kind=$(view "$DAO" get_proposal "{\"id\":$proposal_id}" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["kind"]))')

echo "4. Council approves proposal $proposal_id"
call "$OWNER" "$DAO" act_proposal "{\"id\":$proposal_id,\"action\":\"VoteApprove\",\"proposal\":$kind}" '200 Tgas' '0 NEAR'

echo "5. Result"
view "$DAO" get_proposal "{\"id\":$proposal_id}" | python3 -c 'import sys,json; p=json.load(sys.stdin); print("proposal status:", p["status"])'
view "$CONTRACT" get_config '{}'
view "$CONTRACT" list_envelopes '{}'
