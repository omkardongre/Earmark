"use client";
import Link from "next/link";
import { money, shortName } from "@/lib/format";
import type { SpendRequest, TokenMeta } from "@/lib/types";
import { LocalTime } from "./local-time";
import { PaymentsTable } from "./payments-table";
import { type Team, useRole } from "./roles";
import { Card, Section } from "./ui";
import { useWallet } from "./wallet";

/** "You earned 29 tUSDC here", for a contributor of this budget who has been paid. */
export function Earned({
  team,
  earned,
  meta,
}: {
  team: Team;
  earned: Record<string, string>;
  meta: TokenMeta;
}) {
  const { me, role } = useRole(team);
  const total = me ? earned[me] : undefined;
  if (role !== "contributor" || !total || BigInt(total) === 0n) return null;
  return (
    <p className="rounded-xl bg-emerald-50 px-4 py-2.5 font-medium text-emerald-800">
      You earned <span className="tabular">{money(total, meta)}</span> here
    </p>
  );
}

/** Open tasks of a budget, reduced to what the card needs. */
export type OpenTask = { assignee: string | null };

/**
 * The way into a budget's tasks from its card: "2 tasks you can take" for a contributor who can
 * take them, a plain "Tasks · 2 open" link for everyone else.
 */
export function CardTasks({
  budgetId,
  team,
  open,
}: {
  budgetId: string;
  team: Team;
  open: OpenTask[];
}) {
  const { me, role } = useRole(team);
  const href = `/budgets/${budgetId}/tasks`;
  const mine =
    role === "contributor" ? open.filter((t) => !t.assignee || t.assignee === me).length : 0;
  // Nothing to take or follow: only a lead needs the way in (to post one).
  if (open.length === 0 && role !== "lead") return null;
  if (mine > 0)
    return (
      <Link
        href={href}
        className="flex items-center justify-between gap-3 rounded-xl bg-brand-soft px-4 py-3 font-semibold text-brand hover:bg-indigo-100"
      >
        {mine} {mine === 1 ? "task" : "tasks"} you can take
        <span aria-hidden>→</span>
      </Link>
    );
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-3 font-medium hover:bg-slate-50"
    >
      <span>
        Tasks
        {open.length > 0 && <span className="text-muted"> · {open.length} open</span>}
      </span>
      <span className="text-muted" aria-hidden>
        →
      </span>
    </Link>
  );
}

/** A task that may need someone, as the home page passes it. */
export type ActiveTask = {
  budgetId: string;
  taskId: string;
  title: string;
  amount: string;
  status: "claimed" | "submitted";
  lead: string;
  claimant: string | null;
  sentBack: boolean;
  dueNs: string | null;
};

/**
 * Top of home: the few things waiting on the signed-in person. Work to review (a lead), work to
 * send or fix (a contributor), payments to approve (an approver). Hidden when nothing waits.
 */
export function NeedsYou({
  tasks,
  approvals,
}: {
  tasks: ActiveTask[];
  /** Per budget: its approvers and how many payments wait for one. */
  approvals: { approvers: string[]; count: number }[];
}) {
  const { accountId: me } = useWallet();
  if (!me) return null;
  const toApprove = approvals
    .filter((a) => a.approvers.includes(me))
    .reduce((n, a) => n + a.count, 0);
  const rows = [
    ...tasks
      .filter((t) => t.status === "submitted" && t.lead === me)
      .map((t) => ({
        key: `r${t.taskId}`,
        href: `/budgets/${t.budgetId}/tasks/${t.taskId}`,
        text: t.claimant ? `Review ${shortName(t.claimant)}’s work` : "Review the work",
        sub: t.title,
        right: t.amount,
      })),
    ...tasks
      .filter((t) => t.status === "claimed" && t.claimant === me)
      .map((t) => ({
        key: `w${t.taskId}`,
        href: `/budgets/${t.budgetId}/tasks/${t.taskId}`,
        text: t.sentBack ? "Fix and send again" : "Send your work",
        sub: t.dueNs ? (
          <>
            {t.title} · due <LocalTime ns={t.dueNs} />
          </>
        ) : (
          t.title
        ),
        right: t.amount,
      })),
    ...(toApprove > 0
      ? [
          {
            key: "approve",
            href: "/approvals",
            text: `${toApprove} ${toApprove === 1 ? "payment" : "payments"} to approve`,
            sub: "Waiting for an approver",
            right: null,
          },
        ]
      : []),
  ];
  if (rows.length === 0) return null;
  return (
    <Section title="Needs you">
      <Card className="divide-y divide-line">
        {rows.slice(0, 5).map((r) => (
          <Link
            key={r.key}
            href={r.href}
            className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50"
          >
            <span className="min-w-0">
              <span className="block font-semibold">{r.text}</span>
              <span className="block truncate text-sm text-muted">{r.sub}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              {r.right && <span className="tabular font-semibold">{r.right}</span>}
              <span className="text-brand" aria-hidden>
                →
              </span>
            </span>
          </Link>
        ))}
      </Card>
    </Section>
  );
}

/**
 * "New budget": only for DAO members who can propose it, and for signed-out visitors (who can
 * look at setup). `proposers` null means the DAO policy couldn't be read: show it.
 */
export function NewBudgetLink({ proposers }: { proposers: string[] | null }) {
  const { accountId } = useWallet();
  if (accountId && proposers && !proposers.includes(accountId)) return null;
  return (
    <Link href="/setup" className="text-[15px] font-medium text-brand hover:underline">
      New budget
    </Link>
  );
}

/**
 * The budget's payments. A contributor sees only their own ("Your payments"); everyone else sees
 * all of them, with the CSV download.
 */
export function BudgetPayments({
  budgetId,
  team,
  first,
  total,
  meta,
}: {
  budgetId: string;
  team: Team;
  first: [string, SpendRequest][];
  total: number;
  meta: TokenMeta;
}) {
  const { me, role } = useRole(team);
  if (role === "contributor" && me)
    return (
      <Section title="Your payments">
        <PaymentsTable budgetId={budgetId} first={first} total={total} meta={meta} payee={me} />
      </Section>
    );
  return (
    <Section
      title="Payments"
      action={
        total > 0 && (
          // A plain link: the route handler sends the file as a download.
          <a
            href={`/api/export/${budgetId}`}
            download
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand-soft"
          >
            Download CSV
          </a>
        )
      }
    >
      <PaymentsTable budgetId={budgetId} first={first} total={total} meta={meta} />
    </Section>
  );
}
