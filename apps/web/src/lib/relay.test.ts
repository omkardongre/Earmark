import type { SignedDelegate } from "near-api-js";
import { describe, expect, it } from "vitest";
import { checkShape, MAX_GAS } from "./relay";

const C = "budgets.earmark.testnet";
const call = (methodName: string, { gas = 30n * 10n ** 12n, deposit = 0n, args = {} } = {}) => ({
  functionCall: {
    methodName,
    args: new TextEncoder().encode(JSON.stringify(args)),
    gas,
    deposit,
  },
});
const sd = (actions: object[], receiverId = C) =>
  ({
    delegateAction: { senderId: "priya.earmark.testnet", receiverId, actions },
  }) as unknown as SignedDelegate;

describe("relay checks", () => {
  it("passes one approve to our contract", () => {
    expect(checkShape(sd([call("approve", { args: { request_id: "x" } })]), C)).toEqual({
      ok: true,
      method: "approve",
      args: { request_id: "x" },
    });
  });
  it.each([
    ["another contract", sd([call("approve")], "evil.testnet"), "wrong_contract"],
    ["two calls", sd([call("approve"), call("approve")]), "one_call_only"],
    ["a transfer", sd([{ transfer: { deposit: 1n } }]), "one_call_only"],
    ["attached NEAR", sd([call("approve", { deposit: 1n })]), "no_deposit"],
    ["too much gas", sd([call("approve", { gas: MAX_GAS + 1n })]), "too_much_gas"],
    ["a method off the list", sd([call("upgrade")]), "method_not_sponsored"],
    ["setup (it attaches storage)", sd([call("create_envelope")]), "method_not_sponsored"],
  ])("refuses %s", (_, d, reason) => {
    expect(checkShape(d, C)).toEqual({ ok: false, reason });
  });
});
