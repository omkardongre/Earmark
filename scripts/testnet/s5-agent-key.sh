#!/usr/bin/env bash
# Gives a spender a function-call key that can only call request_spend on Earmark, as an agent
# would hold. Checks that the key can request a spend and that every other call is refused.
# The key lives in a temp dir and is deleted from the account at the end. Run after s1 and s2.
set -euo pipefail

: "${OWNER:?set OWNER, e.g. earmark.testnet}"
NETWORK=testnet
DAO=${DAO:-earmark-demo.sputnikv2.testnet}
CONTRACT=${CONTRACT:-v3.$OWNER}
TOKEN=${TOKEN:-tusdc.$OWNER}
SPENDER=${SPENDER:-$OWNER}
PAYEE=${PAYEE:-$OWNER}
ENVELOPE_ID=${ENVELOPE_ID:-0}
AMOUNT=${AMOUNT:-1000000} # 1 tUSDC, within the 10 tUSDC auto limit
RUN=$(date +%s)
REQUEST_ID=${REQUEST_ID:-s5-$RUN}

rpc() {
  curl -sS -m 20 "https://rpc.$NETWORK.fastnear.com" -H 'Content-Type: application/json' -d "$1"
}
view() { # view <account> <method> <json-args>
  local args
  args=$(printf '%s' "$3" | base64 -w0)
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args\"}}" |
    python3 -c 'import sys,json; r=json.load(sys.stdin); print(bytes(r["result"]["result"]).decode()) if "result" in r and "result" in r["result"] else sys.exit("view failed: %s" % r)'
}
agent_call() { # agent_call <contract> <method> <json-args> <deposit>
  near contract call-function as-transaction "$1" "$2" json-args "$3" \
    prepaid-gas '100 Tgas' attached-deposit "$4" sign-as "$SPENDER" \
    network-config "$NETWORK" sign-with-access-key-file "$KEY_FILE" send
}
refused() { # refused <label> <command...>: the protocol must reject the transaction for the key
  local out
  if out=$("${@:2}" 2>&1); then
    echo "FAIL: $1 succeeded with the agent key"
    exit 1
  fi
  local reason
  reason=$(printf '%s' "$out" | grep -E 'Error: .*access key' | head -1 | sed -E 's/.*Error: //' || true)
  [ -n "$reason" ] || { echo "FAIL: $1 failed for another reason:"; printf '%s\n' "$out" | tail -5; exit 1; }
  echo "refused: $1 ($reason)"
}

KEY_DIR=$(mktemp -d)
chmod 700 "$KEY_DIR"
near account create-account fund-later use-auto-generation save-to-folder "$KEY_DIR" >/dev/null 2>&1
KEY_FILE=$(ls "$KEY_DIR"/*.json)
PUBLIC_KEY=$(python3 -c 'import sys,json; print(json.load(open(sys.argv[1]))["public_key"])' "$KEY_FILE")
cleanup() {
  echo "Removing the agent key from $SPENDER"
  near account delete-keys "$SPENDER" public-keys "$PUBLIC_KEY" \
    network-config "$NETWORK" sign-with-legacy-keychain send >/dev/null 2>&1 || echo "delete-keys failed; remove $PUBLIC_KEY by hand"
  rm -rf "$KEY_DIR"
}
trap cleanup EXIT

echo "1. Add a function-call key to $SPENDER: receiver $CONTRACT, method request_spend only"
near account add-key "$SPENDER" grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id "$CONTRACT" --function-names request_spend \
  use-manually-provided-public-key "$PUBLIC_KEY" \
  network-config "$NETWORK" sign-with-legacy-keychain send

echo "2. The agent key requests $AMOUNT for $PAYEE (request $REQUEST_ID)"
agent_call "$CONTRACT" request_spend \
  "{\"envelope_id\":\"$ENVELOPE_ID\",\"request_id\":\"$REQUEST_ID\",\"payee\":\"$PAYEE\",\"amount\":\"$AMOUNT\",\"memo\":\"Agent spend\",\"work_ref\":\"agent-$RUN\"}" \
  '0 NEAR'
status=$(view "$CONTRACT" get_request "{\"request_id\":\"$REQUEST_ID\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
echo "request status: $status"
[ "$status" = "paid" ] || exit 1

echo "3. Everything else with the agent key"
refused "approve on $CONTRACT" agent_call "$CONTRACT" approve "{\"request_id\":\"$REQUEST_ID\"}" '0 NEAR'
refused "ft_transfer on $TOKEN" agent_call "$TOKEN" ft_transfer "{\"receiver_id\":\"$PAYEE\",\"amount\":\"1\"}" '0 NEAR'
refused "request_spend with a deposit" agent_call "$CONTRACT" request_spend \
  "{\"envelope_id\":\"$ENVELOPE_ID\",\"request_id\":\"$REQUEST_ID-d\",\"payee\":\"$PAYEE\",\"amount\":\"$AMOUNT\",\"memo\":\"\",\"work_ref\":\"agent-$RUN-d\"}" '1 yoctoNEAR'
refused "NEAR transfer to $DAO" near tokens "$SPENDER" send-near "$DAO" '0.001 NEAR' \
  network-config "$NETWORK" sign-with-access-key-file "$KEY_FILE" send
