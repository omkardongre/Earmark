"use client";

import Link from "next/link";
import { Pill } from "./ui";
import { useWallet } from "./wallet";

/** "2 to approve", only for an approver of this budget: others can't act on it. */
export function ApproveBadge({ approvers, count }: { approvers: string[]; count: number }) {
  const { accountId } = useWallet();
  if (count === 0 || !accountId || !approvers.includes(accountId)) return null;
  return (
    <Link href="/approvals">
      <Pill tone="amber">{count} to approve</Pill>
    </Link>
  );
}
