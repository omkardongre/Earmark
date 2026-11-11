"use client";
import type { ReactNode } from "react";
import { useWallet } from "./wallet";

/**
 * Who the signed-in person is in one budget. A lead (spender) posts tasks and pays, an approver
 * signs bigger payments, a contributor (payee only) does the work. Anyone else, signed out
 * included, is a visitor and sees the full public view.
 */
export type Role = "lead" | "approver" | "contributor" | "visitor";
export type Team = { spenders: string[]; approvers: string[]; payees: string[] };

export function roleOf(me: string | null, t: Team): Role {
  if (!me) return "visitor";
  if (t.spenders.includes(me)) return "lead";
  if (t.approvers.includes(me)) return "approver";
  if (t.payees.includes(me)) return "contributor";
  return "visitor";
}

export function useRole(t: Team): { me: string | null; role: Role } {
  const { accountId } = useWallet();
  return { me: accountId, role: roleOf(accountId, t) };
}

/** Shows its children only to the given roles. */
export function ForRoles({
  team,
  roles,
  children,
}: {
  team: Team;
  roles: Role[];
  children: ReactNode;
}) {
  const { role } = useRole(team);
  return roles.includes(role) ? children : null;
}
