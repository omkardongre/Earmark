#!/usr/bin/env bash
# Deploys the test token, gives the DAO tokens and has the DAO fund budget 0 through a Transfer
# proposal with `msg` (ft_transfer_call). Run after s1-create-envelope.sh. Testnet only.
set -euo pipefail

: "${OWNER:?set OWNER, e.g. earmark.testnet}"
NETWORK=testnet
DAO=${DAO:-earmark-demo.sputnikv2.testnet}
CONTRACT=${CONTRACT:-v2.$OWNER}
TOKEN=${TOKEN:-tusdc.$OWNER}
ENVELOPE_ID=${ENVELOPE_ID:-0}
MINT=${MINT:-1000000000}   # 1,000 tUSDC (6 decimals)
FUND=${FUND:-300000000}    # 300 tUSDC
TOKEN_WASM=${TOKEN_WASM:-target/near/test_token/test_token.wasm}

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

echo "1. Test token $TOKEN"
if ! exists "$TOKEN"; then
  near account create-account fund-myself "$TOKEN" '2 NEAR' autogenerate-new-keypair \
    --signature-scheme ed25519 save-to-legacy-keychain sign-as "$OWNER" \
    network-config "$NETWORK" sign-with-legacy-keychain send
  near contract deploy "$TOKEN" use-file "$TOKEN_WASM" with-init-call new \
    json-args "{\"owner_id\":\"$OWNER\",\"name\":\"Test USDC\",\"symbol\":\"tUSDC\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi

echo "2. Register DAO and contract with the token, mint to the DAO"
min=$(view "$TOKEN" storage_balance_bounds '{}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["min"])')
for account in "$DAO" "$CONTRACT"; do
  if [ "$(view "$TOKEN" storage_balance_of "{\"account_id\":\"$account\"}")" = "null" ]; then
    call "$OWNER" "$TOKEN" storage_deposit "{\"account_id\":\"$account\",\"registration_only\":true}" '30 Tgas' "$min yoctoNEAR"
  fi
done
call "$OWNER" "$TOKEN" mint "{\"account_id\":\"$DAO\",\"amount\":\"$MINT\"}" '30 Tgas' '0 NEAR'

echo "3. Proposal: DAO transfers $FUND to budget $ENVELOPE_ID with msg"
bond=$(view "$DAO" get_policy '{}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["proposal_bond"])')
msg=$(printf '{\\"envelope_id\\":\\"%s\\"}' "$ENVELOPE_ID")
proposal=$(printf '{"proposal":{"description":"Fund Earmark budget %s","kind":{"Transfer":{"token_id":"%s","receiver_id":"%s","amount":"%s","msg":"%s"}}}}' \
  "$ENVELOPE_ID" "$TOKEN" "$CONTRACT" "$FUND" "$msg")
call "$OWNER" "$DAO" add_proposal "$proposal" '50 Tgas' "$bond yoctoNEAR"
proposal_id=$(( $(view "$DAO" get_last_proposal_id '{}') - 1 ))
kind=$(view "$DAO" get_proposal "{\"id\":$proposal_id}" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["kind"]))')

echo "4. Council approves proposal $proposal_id"
call "$OWNER" "$DAO" act_proposal "{\"id\":$proposal_id,\"action\":\"VoteApprove\",\"proposal\":$kind}" '300 Tgas' '0 NEAR'

echo "5. Result"
view "$DAO" get_proposal "{\"id\":$proposal_id}" | python3 -c 'import sys,json; print("proposal status:", json.load(sys.stdin)["status"])'
echo "contract token balance: $(view "$TOKEN" ft_balance_of "{\"account_id\":\"$CONTRACT\"}")"
view "$CONTRACT" get_envelope "{\"envelope_id\":\"$ENVELOPE_ID\"}" | python3 -c 'import sys,json; e=json.load(sys.stdin); print("budget balance:", e["balance"], "available:", e["available"])'
