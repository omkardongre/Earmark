import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TaskView } from "@/components/task-view";
import { TelegramWatch } from "@/components/telegram-link";
import { loadBase, requestEvents } from "@/lib/data";
import { getRequest, getTask, getTrust } from "@/lib/near";
import { alertsOn } from "@/lib/telegram";

export const metadata: Metadata = { title: "Task · Earmark" };
export const dynamic = "force-dynamic";

/** When a paid task's money went out: at once for an instant payment, else its payout event. */
async function paidAt(requestId: string): Promise<string | null> {
  const r = await getRequest(requestId).catch(() => null);
  if (!r || (r.status !== "paid" && r.status !== "paid_by_dao")) return null;
  if (r.tier === "auto" || r.tier === "trusted") return r.created_at_ns;
  const events = await requestEvents(requestId);
  return events?.findLast((e) => e.event === "spend_paid")?.timestampNs ?? null;
}

/** One task: what it pays, who's on it, and the one next step for whoever is signed in. */
export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string; taskId: string }>;
}) {
  const { id, taskId } = await params;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(taskId)) notFound();
  const [base, task] = await Promise.all([loadBase(), getTask(taskId)]);
  const b = base.budgets.find((x) => x.id === id);
  const m = base.meta.get(id);
  if (!b || !m || !task || task.envelope_id !== id) notFound();
  const [trust, paidNs] = await Promise.all([
    task.claimant ? getTrust(id, task.claimant).catch(() => null) : null,
    task.status === "paid" && task.request_id ? paidAt(task.request_id) : null,
  ]);
  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="space-y-1">
        <Link href={`/budgets/${id}/tasks`} className="text-muted hover:text-ink">
          ← Tasks
        </Link>
        <h1 className="text-3xl font-bold tracking-tight break-words">{task.title}</h1>
      </div>
      <TaskView
        taskId={taskId}
        initial={task}
        initialTrust={trust}
        initialPaidNs={paidNs}
        team={{ spenders: b.spenders.map(([a]) => a), approvers: b.approvers, payees: b.payees }}
        meta={m}
      />
      {alertsOn() && task.status !== "paid" && task.status !== "cancelled" && (
        <div className="text-center">
          <TelegramWatch taskId={taskId} />
        </div>
      )}
    </div>
  );
}
