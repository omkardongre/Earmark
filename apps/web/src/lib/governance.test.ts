import { describe, expect, it } from "vitest";
import { moneyRules, type Policy, votesNeeded } from "./governance";

// The two real policies (get_policy, 13 Nov): Trezu-shaped, with Requestor, Admin and Approver.
const role = (name: string, members: string[], permissions: string[], threshold: string) => ({
  name,
  kind: { Group: members },
  permissions,
  vote_policy: {
    call: { weight_kind: "RoleWeight" as const, quorum: "0", threshold },
    transfer: { weight_kind: "RoleWeight" as const, quorum: "0", threshold },
  },
});
const half = {
  weight_kind: "RoleWeight" as const,
  quorum: "0",
  threshold: [1, 2] as [number, number],
};
const policy = (approvers: string[], threshold: string): Policy => ({
  roles: [
    role("Requestor", ["dao-member", "budgets"], ["call:AddProposal", "transfer:AddProposal"], "1"),
    role("Admin", approvers, ["upgrade_remote:*", "factory_info_update:*"], threshold),
    role("Approver", approvers, ["call:VoteApprove", "transfer:VoteApprove"], threshold),
  ],
  default_vote_policy: half,
});

describe("votesNeeded", () => {
  it("reads a 1-of-1 treasury as one person deciding alone", () => {
    const r = moneyRules(policy(["omkar5.near"], "1"));
    expect(r.payouts).toMatchObject({ role: "Approver", needed: 1, of: 1 });
    expect(r.alone).toBe(true);
  });

  it("counts a fixed threshold and falls back to the default ratio", () => {
    const p = policy(["priya", "daniel", "lena"], "2");
    expect(votesNeeded(p, "transfer")).toMatchObject({ needed: 2, of: 3 });
    // Admin has no upgrade_remote entry here beyond call/transfer: the default 1/2 → 2 of 3.
    expect(votesNeeded(p, "upgrade_remote")).toMatchObject({ role: "Admin", needed: 2, of: 3 });
    // Requestor may only propose, never approve.
    expect(votesNeeded(p, "policy")).toBeNull();
    expect(moneyRules(p).alone).toBe(false);
  });
});
