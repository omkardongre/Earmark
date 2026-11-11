import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ACTIVE, TaskList } from "@/components/task-list";
import { ButtonLink, Empty, Section } from "@/components/ui";
import { loadBase } from "@/lib/data";
import { money } from "@/lib/format";
import { getTaskRules, listTasks } from "@/lib/near";

export const metadata: Metadata = { title: "Tasks · Earmark" };
export const dynamic = "force-dynamic";

/** A budget's task board: what's open, what's in progress, what's been paid. */
export default async function TasksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const base = await loadBase();
  const b = base.budgets.find((x) => x.id === id);
  const m = base.meta.get(id);
  if (!b || !m) notFound();
  const [tasks, rules] = await Promise.all([listTasks(id), getTaskRules(id)]);

  const open = tasks?.filter(([, t]) => t.status === "open") ?? [];
  const doing = tasks?.filter(([, t]) => ACTIVE.has(t.status) && t.status !== "open") ?? [];
  const done = tasks?.filter(([, t]) => t.status === "paid").slice(0, 10) ?? [];
  const trusted = rules && BigInt(rules.trusted_limit) > 0n;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <Link href={`/budgets/${id}`} className="text-muted hover:text-ink">
            ← {b.name}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Tasks</h1>
          <p className="text-muted">
            Paid from this budget. The money is set aside when a task is posted.
          </p>
        </div>
        {tasks && !b.closed && (
          <ButtonLink href={`/budgets/${id}/tasks/new`}>Post a task</ButtonLink>
        )}
      </div>

      {!tasks ? (
        <Empty>Tasks aren’t available on this contract yet.</Empty>
      ) : (
        <>
          <Section title="Open">
            {open.length ? (
              <TaskList budgetId={id} tasks={open} meta={m} />
            ) : (
              <Empty>No open tasks right now.</Empty>
            )}
          </Section>
          {doing.length > 0 && (
            <Section title="In progress">
              <TaskList budgetId={id} tasks={doing} meta={m} />
            </Section>
          )}
          {done.length > 0 && (
            <Section title="Paid">
              <TaskList budgetId={id} tasks={done} meta={m} />
            </Section>
          )}
          {rules && (
            <p className="text-sm text-muted">
              {trusted
                ? `After ${rules.min_tasks} accepted, paid ${rules.min_tasks === 1 ? "task" : "tasks"} here${rules.min_days > 0 ? ` over ${rules.min_days} days` : ""}, with none rejected as not acceptable, a contributor is trusted: the lead still accepts the work, and the payment clears without an approver, up to ${money(rules.trusted_limit, m)}.`
                : "Every finished task builds the contributor’s record here. The DAO can turn on trusted contributors for this budget."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
