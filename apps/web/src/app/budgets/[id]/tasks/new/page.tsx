import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PostTaskForm } from "@/components/post-task-form";
import { Card } from "@/components/ui";
import { loadBase } from "@/lib/data";
import { listTasks } from "@/lib/near";

export const metadata: Metadata = { title: "Post a task · Earmark" };
export const dynamic = "force-dynamic";

export default async function NewTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const base = await loadBase();
  const b = base.budgets.find((x) => x.id === id);
  const m = base.meta.get(id);
  if (!b || !m) notFound();
  const supported = (await listTasks(id, { limit: 1 })) !== null;
  const spenders = b.spenders.map(([a]) => a);
  const contributors = b.payees.filter((p) => !spenders.includes(p) && !b.approvers.includes(p));

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="space-y-1">
        <Link href={`/budgets/${id}/tasks`} className="text-muted hover:text-ink">
          ← Tasks
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Post a task</h1>
        <p className="text-muted">Someone takes it, sends the work, and you accept to pay.</p>
      </div>
      <Card className="p-6">
        {b.closed || !supported ? (
          <p className="text-muted">
            {b.closed ? "This budget is closed." : "Tasks aren’t available on this contract yet."}
          </p>
        ) : (
          <PostTaskForm
            budgetId={id}
            spenders={spenders}
            payees={contributors}
            available={b.available}
            maxAmount={b.one_approver_limit}
            paused={{
              budget: b.paused,
              leads: b.spenders.filter(([, l]) => l.paused).map(([a]) => a),
            }}
            meta={m}
          />
        )}
      </Card>
    </div>
  );
}
