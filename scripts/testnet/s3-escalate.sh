#!/usr/bin/env bash
# A spender requests more than the one-approver limit. The contract reads the DAO's bond from
# get_policy, files a Transfer proposal paying the DAO's own bond, and the council votes. Checks
# that the payee is paid from the DAO treasury and the bond comes back. Run after s1 and s2.
set -euo pipefail

: "${OWNER:?set OWNER, e.g. earmark.testnet}"
NETWORK=testnet
DAO=${DAO:-earmark-demo.sputnikv2.testnet}
CONTRACT=${CONTRACT:-v2.$OWNER}
TOKEN=${TOKEN:-tusdc.$OWNER}
SPENDER=${SPENDER:-$OWNER}
PAYEE=${PAYEE:-$OWNER}
ENVELOPE_ID=${ENVELOPE_ID:-0}
AMOUNT=${AMOUNT:-300000000} # 300 tUSDC, above the 50 tUSDC one-approver limit
RUN=$(date +%s)
REQUEST_ID=${REQUEST_ID:-s3-$RUN}

rpc() {
  curl -sS -m 20 "https://rpc.$NETWORK.fastnear.com" -H 'Content-Type: application/json' -d "$1"
}
view() { # view <account> <method> <json-args>
  local args
  args=$(printf '%s' "$3" | base64 -w0)
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args\"}}" |
    python3 -c 'import sys,json; r=json.load(sys.stdin); print(bytes(r["result"]["result"]).decode()) if "result" in r and "result" in r["result"] else sys.exit("view failed: %s" % r)'
}
near_balance() {
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["amount"])'
}
call() { # call <signer> <contract> <method> <json-args> <gas> <deposit>
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "$5" attached-deposit "$6" sign-as "$1" \
    network-config "$NETWORK" sign-with-legacy-keychain send
}

payee_before=$(view "$TOKEN" ft_balance_of "{\"account_id\":\"$PAYEE\"}" | tr -d '"')

echo "1. $SPENDER requests $AMOUNT for $PAYEE (request $REQUEST_ID)"
view "$CONTRACT" check_spend "{\"envelope_id\":\"$ENVELOPE_ID\",\"spender\":\"$SPENDER\",\"request_id\":\"$REQUEST_ID\",\"payee\":\"$PAYEE\",\"amount\":\"$AMOUNT\",\"work_ref\":\"invoice-$RUN\"}"
call "$SPENDER" "$CONTRACT" request_spend \
  "{\"envelope_id\":\"$ENVELOPE_ID\",\"request_id\":\"$REQUEST_ID\",\"payee\":\"$PAYEE\",\"amount\":\"$AMOUNT\",\"memo\":\"Conference venue\",\"work_ref\":\"invoice-$RUN\"}" \
  '100 Tgas' '0 NEAR'

request=$(view "$CONTRACT" get_request "{\"request_id\":\"$REQUEST_ID\"}")
status=$(printf '%s' "$request" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
echo "request status: $status"
[ "$status" = "escalated" ] || { echo "$request"; exit 1; }
proposal_id=$(printf '%s' "$request" | python3 -c 'import sys,json; print(json.load(sys.stdin)["dao_proposal_id"])')
contract_before_vote=$(near_balance "$CONTRACT")

echo "2. Council approves DAO proposal $proposal_id"
kind=$(view "$DAO" get_proposal "{\"id\":$proposal_id}" | python3 -c 'import sys,json; p=json.load(sys.stdin); print("proposer:", p["proposer"], file=sys.stderr); print(json.dumps(p["kind"]))')
call "$OWNER" "$DAO" act_proposal "{\"id\":$proposal_id,\"action\":\"VoteApprove\",\"proposal\":$kind}" '300 Tgas' '0 NEAR'

echo "3. Result"
view "$DAO" get_proposal "{\"id\":$proposal_id}" | python3 -c 'import sys,json; print("proposal status:", json.load(sys.stdin)["status"])'
payee_after=$(view "$TOKEN" ft_balance_of "{\"account_id\":\"$PAYEE\"}" | tr -d '"')
echo "payee received: $((payee_after - payee_before))"
contract_after_vote=$(near_balance "$CONTRACT")
python3 -c "print('bond returned to contract (NEAR):', ($contract_after_vote - $contract_before_vote) / 1e24)"
view "$CONTRACT" get_envelope "{\"envelope_id\":\"$ENVELOPE_ID\"}" | python3 -c 'import sys,json; e=json.load(sys.stdin); print("budget available (unchanged by escalation):", e["available"])'
