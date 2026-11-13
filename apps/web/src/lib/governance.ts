// Who really controls a Sputnik DAO: how many members must vote yes to pass a proposal of a given
// kind, counted the way Sputnik v2 counts (`policy.rs`: `proposal_status`, `to_weight`). Pure and
// import-free, so the web app (Verify page, budget page) and `make verify` share one copy.

type WeightOrRatio = string | [number, number];
export type VotePolicy = {
  weight_kind: "RoleWeight" | "TokenWeight";
  quorum: string;
  threshold: WeightOrRatio;
};
export type PolicyRole = {
  name: string;
  kind: "Everyone" | { Group: string[] } | { Member: string };
  permissions: string[];
  vote_policy: Record<string, VotePolicy>;
};
export type Policy = { roles: PolicyRole[]; default_vote_policy: VotePolicy };

/** The cheapest way to pass a proposal kind: `needed` yes votes out of the role's `of` members. */
export type VoteRule = { role: string; needed: number; of: number; members: string[] };

/** Sputnik's check: `kind:action`, `kind:*`, `*:action` or `*:*`. */
const permits = (p: string[], kind: string, action: string) =>
  p.includes(`${kind}:${action}`) ||
  p.includes(`${kind}:*`) ||
  p.includes(`*:${action}`) ||
  p.includes("*:*");

/** `WeightOrRatio::to_weight`: a fixed count (capped at the group size) or a share, rounded up. */
function toWeight(t: WeightOrRatio, total: number): number {
  if (Array.isArray(t)) return Math.min(Math.floor((t[0] * total) / t[1]) + 1, total);
  return Math.min(Number(t), total);
}

/**
 * Fewest yes votes that pass a proposal of `kind` (Sputnik labels: "transfer", "call",
 * "upgrade_remote", "factory_info_update", "policy", …). Sputnik approves a proposal as soon as any
 * one role that may vote on it reaches its threshold, so the answer is the smallest over roles.
 * Roles open to everyone and token-weighted votes are skipped: they don't count named people.
 * Null when no named role can approve this kind.
 */
export function votesNeeded(policy: Policy, kind: string): VoteRule | null {
  let best: VoteRule | null = null;
  for (const role of policy.roles) {
    if (typeof role.kind !== "object" || !("Group" in role.kind)) continue;
    if (!permits(role.permissions, kind, "VoteApprove")) continue;
    const vp = role.vote_policy[kind] ?? policy.default_vote_policy;
    if (vp.weight_kind !== "RoleWeight") continue;
    const members = role.kind.Group;
    if (members.length === 0) continue;
    const needed = Math.max(Number(vp.quorum), toWeight(vp.threshold, members.length));
    if (!best || needed < best.needed)
      best = { role: role.name, needed, of: members.length, members };
  }
  return best;
}

/** "1 of 1", "2 of 3": how many members of the deciding role must vote yes. */
export const ruleText = (r: VoteRule) => `${r.needed} of ${r.of}`;

/** The rules that matter for money: payouts (Transfer) and contract calls (budgets, code). */
export function moneyRules(policy: Policy) {
  const payouts = votesNeeded(policy, "transfer");
  const calls = votesNeeded(policy, "call");
  const code = votesNeeded(policy, "upgrade_remote");
  const rules = [payouts, calls, code].filter((r): r is VoteRule => r !== null);
  return {
    payouts,
    calls,
    code,
    /** One person can pass a payout, a budget change or new code alone. */
    alone: rules.some((r) => r.needed === 1),
  };
}

/** `get_factory_info` on a Sputnik DAO. */
export type FactoryInfo = { factory_id: string; auto_update: boolean };
