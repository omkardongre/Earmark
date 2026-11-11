import Link from "next/link";
import { ActivityList } from "@/components/activity-list";
import { BudgetCard } from "@/components/budget-card";
import { Landing } from "@/components/landing";
import { type ActiveTask, NeedsYou, NewBudgetLink } from "@/components/role-views";
import { SignedOut } from "@/components/signed-out";
import { Empty, Section } from "@/components/ui";
import { getPolicy, groupProposers } from "@/lib/dao";
import { loadActivity, loadBase, paidByPayee } from "@/lib/data";
import { money, TASK_SYSTEM_REASON } from "@/lib/format";
import { listRequests, listTasks } from "@/lib/near";

export const dynamic = "force-dynamic";

export default async function Home() {
  const base = await loadBase();
  const { budgets, meta, config } = base;
  const open = budgets.filter((b) => !b.closed);
  const closed = budgets.filter((b) => b.closed);
  const [activity, requests, tasks, earned, proposers] = await Promise.all([
    loadActivity(base, { skipChanges: true }),
    Promise.all(open.map((b) => listRequests(b.id, { limit: 100 }))).then((l) => l.flat()),
    // Null for a budget on a contract without tasks; a failed read shows no task row.
    Promise.all(open.map((b) => listTasks(b.id, { limit: 100 }).catch(() => null))),
    Promise.all(open.map((b) => paidByPayee(b))),
    getPolicy(config.dao_id)
      .then((p) => groupProposers(p, "call"))
      .catch(() => null),
  ]);
  const active: ActiveTask[] = open.flatMap((b, i) => {
    const m = meta.get(b.id);
    if (!m) return [];
    return (tasks[i] ?? []).flatMap(([taskId, t]) =>
      t.status === "claimed" || t.status === "submitted"
        ? [
            {
              budgetId: b.id,
              taskId,
              title: t.title,
              amount: money(t.amount, m),
              status: t.status,
              lead: t.lead,
              claimant: t.claimant,
              sentBack: t.status === "claimed" && !!t.reason && !(t.reason in TASK_SYSTEM_REASON),
              dueNs: t.claim_ends_ns,
            },
          ]
        : [],
    );
  });
  return (
    <div className="space-y-10">
      <SignedOut>
        <Landing requests={requests} meta={meta.values().next().value} />
      </SignedOut>
      <NeedsYou
        tasks={active}
        approvals={open.map((b) => ({ approvers: b.approvers, count: b.pending_requests.length }))}
      />
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold tracking-tight">Budgets</h2>
        <NewBudgetLink proposers={proposers} />
      </div>
      {open.length === 0 ? (
        <Empty>
          No budgets yet.{" "}
          <Link href="/setup" className="font-medium text-brand hover:underline">
            Set one up
          </Link>{" "}
          and the DAO votes on it.
        </Empty>
      ) : (
        <div className={`grid gap-4 ${open.length > 1 ? "md:grid-cols-2" : ""}`}>
          {open.map((b, i) => {
            const m = meta.get(b.id);
            const list = tasks[i];
            return m ? (
              <BudgetCard
                key={b.id}
                b={b}
                m={m}
                earned={earned[i] ?? {}}
                openTasks={
                  list
                    ? list
                        .filter(([, t]) => t.status === "open")
                        .map(([, t]) => ({ assignee: t.assignee }))
                    : null
                }
              />
            ) : null;
          })}
        </div>
      )}
      {closed.length > 0 && (
        <p className="text-muted">
          Closed:{" "}
          {closed.map((b, i) => (
            <span key={b.id}>
              {i > 0 && ", "}
              <Link href={`/budgets/${b.id}`} className="hover:underline">
                {b.name}
              </Link>
            </span>
          ))}
        </p>
      )}
      <Section title="Recent activity">
        <ActivityList
          first={activity}
          skipChanges
          pageSize={5}
          empty="Nothing yet. Make the first payment above."
        />
      </Section>
    </div>
  );
}
