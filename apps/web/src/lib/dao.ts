// Sputnik DAO v2 helpers for budget setup: read the policy, check who may file which proposal, and
// build the exact `add_proposal` arguments (the same shapes scripts/testnet/demo.ts sends).
import { RPC_URL } from "./config";
import { view } from "./near";

export type RoleKind = "Everyone" | { Group: string[] } | { Member: string };

export type DaoRole = {
  name: string;
  kind: RoleKind;
  permissions: string[];
  vote_policy: Record<string, unknown>;
};

export type DaoPolicy = {
  roles: DaoRole[];
  default_vote_policy: unknown;
  /** yoctoNEAR the proposer attaches to `add_proposal`. */
  proposal_bond: string;
  proposal_period: string;
};

/** Sputnik's policy labels for the proposal kinds setup uses. */
export type KindLabel = "call" | "transfer" | "add_member_to_role" | "policy_add_or_update_role";

export const getPolicy = (dao: string) => view<DaoPolicy>(dao, "get_policy");

export function roleMembers(role: DaoRole): string[] {
  return typeof role.kind === "object" && "Group" in role.kind ? role.kind.Group : [];
}

/** Whether `account` is in `role`. Token-weighted roles count only when they need no tokens. */
function inRole(role: DaoRole, account: string): boolean {
  if (role.kind === "Everyone") return true;
  if ("Group" in role.kind) return role.kind.Group.includes(account);
  return BigInt(role.kind.Member) === 0n;
}

/** Same check as Sputnik's `can_execute_action`: `kind:action`, `kind:*`, `*:action` or `*:*`. */
function permits(role: DaoRole, kind: KindLabel, action: string): boolean {
  const p = role.permissions;
  return (
    p.includes(`${kind}:${action}`) ||
    p.includes(`${kind}:*`) ||
    p.includes(`*:${action}`) ||
    p.includes("*:*")
  );
}

/** Roles that let `account` file a proposal of this kind. */
export function proposeRoles(policy: DaoPolicy, account: string, kind: KindLabel): string[] {
  return policy.roles
    .filter((r) => inRole(r, account) && permits(r, kind, "AddProposal"))
    .map((r) => r.name);
}

export const canPropose = (policy: DaoPolicy, account: string, kind: KindLabel) =>
  proposeRoles(policy, account, kind).length > 0;

/**
 * Whether the Earmark contract can file escalations in this DAO. An escalation is a `Transfer`
 * proposal the contract files itself, so it needs a role with `transfer:AddProposal` (or a
 * wildcard). `roles` names the roles that allow it. The contract also pays the DAO's proposal
 * bond from its own NEAR, so a non-zero `policy.proposal_bond` needs that much free balance.
 */
export function canContractEscalate(
  policy: DaoPolicy,
  contractId: string,
): { ok: boolean; roles: string[] } {
  const roles = proposeRoles(policy, contractId, "transfer");
  return { ok: roles.length > 0, roles };
}

/** Approvers to suggest: members of the DAO's Approver role, else its council. */
export function suggestedApprovers(policy: DaoPolicy): { role: string | null; members: string[] } {
  const pick = (re: RegExp) => policy.roles.find((r) => re.test(r.name) && roleMembers(r).length);
  const role = pick(/^approvers?$/i) ?? pick(/^council$/i);
  return role ? { role: role.name, members: roleMembers(role) } : { role: null, members: [] };
}

// --- Proposal kinds (JSON exactly as `add_proposal` takes it) ---

const encoder = new TextEncoder();
function toBase64(s: string): string {
  return typeof window === "undefined"
    ? Buffer.from(s).toString("base64")
    : btoa(Array.from(encoder.encode(s), (b) => String.fromCharCode(b)).join(""));
}
export function fromBase64(s: string): string {
  return typeof window === "undefined"
    ? Buffer.from(s, "base64").toString()
    : new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

/** Largest of the values (Math.max doesn't take bigints). */
export function maxBig(...xs: bigint[]): bigint {
  let m = 0n;
  for (const x of xs) if (x > m) m = x;
  return m;
}

const NEAR = 10n ** 24n;
const MILLINEAR = 10n ** 21n;

export type EnvelopeInput = {
  name: string;
  token_id: string;
  spenders: { account_id: string; auto_limit: string; period_cap: string }[];
  approvers: string[];
  one_approver_limit: string;
  raise_ceiling: string;
  payees: string[];
  period_secs: string;
  period_cap: string;
};

/**
 * Storage the DAO attaches to `create_envelope`; the contract refunds what it doesn't use.
 * 0.1 NEAR (as the demo script) or 3 milliNEAR per listed account, whichever is more.
 */
export function createDeposit(e: EnvelopeInput): string {
  const accounts = BigInt(e.spenders.length + e.approvers.length + e.payees.length);
  const d = 3n * MILLINEAR * accounts;
  return maxBig(d, NEAR / 10n).toString();
}

export function createEnvelopeKind(contract: string, envelope: EnvelopeInput) {
  return {
    FunctionCall: {
      receiver_id: contract,
      actions: [
        {
          method_name: "create_envelope",
          args: toBase64(JSON.stringify({ envelope })),
          deposit: createDeposit(envelope),
          gas: "50000000000000",
        },
      ],
    },
  };
}

/** The DAO sends tokens to the contract with `ft_transfer_call`; `msg` names the budget. */
export function fundKind(token: string, contract: string, amount: string, envelopeId: string) {
  return {
    Transfer: {
      token_id: token,
      receiver_id: contract,
      amount,
      msg: JSON.stringify({ envelope_id: envelopeId }),
    },
  };
}

/**
 * What lets the contract file escalations: join a group role that may file transfers (Trezu's
 * Requestor, as NEARN joins it), or, if the DAO has none, a new role that may only do that.
 */
export function escalationFix(policy: DaoPolicy, contract: string) {
  const group = policy.roles.filter((r) => typeof r.kind === "object" && "Group" in r.kind);
  const role =
    group.find((r) => /^requestors?$/i.test(r.name) && permits(r, "transfer", "AddProposal")) ??
    group.find((r) => permits(r, "transfer", "AddProposal") && !permits(r, "call", "VoteApprove"));
  if (role) {
    return {
      label: "add_member_to_role" as const,
      role: role.name,
      kind: { AddMemberToRole: { member_id: contract, role: role.name } },
    };
  }
  return {
    label: "policy_add_or_update_role" as const,
    role: "Earmark",
    kind: {
      ChangePolicyAddOrUpdateRole: {
        role: {
          name: "Earmark",
          kind: { Group: [contract] },
          permissions: ["transfer:AddProposal"],
          vote_policy: {},
        },
      },
    },
  };
}

/** Sputnik's status for a proposal that ran: `Approved`; `InProgress` while voting. */
export type ProposalStatus =
  | "InProgress"
  | "Approved"
  | "Rejected"
  | "Removed"
  | "Expired"
  | "Moved"
  | "Failed";

// --- Account checks ---

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const validAccountId = (id: string) =>
  id.length >= 2 && id.length <= 64 && ACCOUNT_RE.test(id);

/** `view_account`: true if the account exists on the configured network. */
export async function accountExists(id: string): Promise<boolean> {
  if (!validAccountId(id)) return false;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "earmark",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: id },
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as {
    result?: { amount?: string };
    error?: { cause?: { name?: string } };
  };
  if (body.result?.amount !== undefined) return true;
  if (body.error?.cause?.name === "UNKNOWN_ACCOUNT") return false;
  throw new Error(body.error?.cause?.name ?? "view_account failed");
}

export const ftBalance = (token: string, account: string) =>
  view<string>(token, "ft_balance_of", { account_id: account });

export const ftRegistered = (token: string, account: string) =>
  view<unknown>(token, "storage_balance_of", { account_id: account }).then((b) => b !== null);
