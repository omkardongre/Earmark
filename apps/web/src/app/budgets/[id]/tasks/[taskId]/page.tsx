import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { TaskActions } from "@/components/task-actions";
import { Card, ExternalLink, Person, Pill } from "@/components/ui";
import { loadBase } from "@/lib/data";
import { money, TASK_STATUS } from "@/lib/format";
import { getTask, getTrust } from "@/lib/near";

export const metadata: Metadata = { title: "Task · Earmark" };
export const dynamic = "force-dynamic";

const isLink = (s: string) => /^https?:\/\//i.test(s);

const REASON: Record<string, string> = {
  claim_expired: "The last claim ran out of time.",
  released: "The last person gave it back.",
  transfer_failed: "The payment didn’t go through. The money is set aside again.",
  funds_gone: "The payment failed and the budget no longer had the money.",
  closed: "The budget was closed.",
};

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
  const trust = task.claimant ? await getTrust(id, task.claimant) : null;
  const s = TASK_STATUS[task.status];

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="space-y-1">
        <Link href={`/budgets/${id}/tasks`} className="text-muted hover:text-ink">
          ← Tasks
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">{task.title}</h1>
      </div>

      <Card className="space-y-6 p-6">
        <div className="flex items-center justify-between gap-3">
          <p className="tabular text-4xl font-bold tracking-tight">{money(task.amount, m)}</p>
          <Pill tone={s.tone}>{s.label}</Pill>
        </div>
        <TaskActions
          taskId={taskId}
          task={task}
          payees={b.payees}
          spenders={b.spenders.map(([a]) => a)}
          approvers={b.approvers}
          meta={m}
        />
      </Card>

      <Card className="p-6">
        <dl className="space-y-3">
          <Row label="Posted by">
            <Person id={task.lead} />
          </Row>
          {task.brief && (
            <Row label="Brief">
              {isLink(task.brief) ? (
                <ExternalLink href={task.brief}>Open the brief</ExternalLink>
              ) : (
                task.brief
              )}
            </Row>
          )}
          {task.assignee && (
            <Row label="Only for">
              <Person id={task.assignee} />
            </Row>
          )}
          {task.claimant && (
            <Row
              label={
                task.status === "paid" || task.status === "accepted" ? "Done by" : "Working on it"
              }
            >
              <span className="flex items-center gap-2">
                <Person id={task.claimant} />
                {trust?.trusted && <Pill tone="green">Trusted</Pill>}
              </span>
            </Row>
          )}
          {task.status === "claimed" && task.claim_ends_ns && (
            <Row label="Due">
              <LocalTime ns={task.claim_ends_ns} />
            </Row>
          )}
          {task.work_ref && (
            <Row label="Work">
              {isLink(task.work_ref) ? (
                <ExternalLink href={task.work_ref}>Open the work</ExternalLink>
              ) : (
                task.work_ref
              )}
            </Row>
          )}
          {task.note && <Row label="Note">{task.note}</Row>}
          {task.reason && task.status !== "paid" && (
            <Row label="Last update">{REASON[task.reason] ?? task.reason}</Row>
          )}
          <Row label="Posted">
            <LocalTime ns={task.created_at_ns} />
          </Row>
        </dl>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
