import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PostTaskButton, TaskBoard, TrustLine } from "@/components/task-board";
import { Empty } from "@/components/ui";
import { loadBase } from "@/lib/data";
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
  const team = { spenders: b.spenders.map(([a]) => a), approvers: b.approvers, payees: b.payees };
  const canPost = !!tasks && !b.closed;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <Link href={`/budgets/${id}`} className="text-muted hover:text-ink">
          ← Back to budget
        </Link>
        <div className="flex min-h-11.5 flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight">
            Tasks <span className="font-semibold text-muted">· {b.name}</span>
          </h1>
          {canPost && <PostTaskButton budgetId={id} team={team} />}
        </div>
      </div>
      {!tasks ? (
        <Empty>Tasks aren’t available on this contract yet.</Empty>
      ) : (
        <>
          <TaskBoard budgetId={id} tasks={tasks} meta={m} team={team} canPost={canPost} />
          {rules && <TrustLine rules={rules} meta={m} team={team} />}
        </>
      )}
    </div>
  );
}
