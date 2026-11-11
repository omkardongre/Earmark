import Link from "next/link";
import { money, shortName, TASK_STATUS } from "@/lib/format";
import type { Task, TokenMeta } from "@/lib/types";
import { Card, Pill } from "./ui";

/** Tasks still to do or being done, before finished ones. */
export const ACTIVE = new Set(["open", "claimed", "submitted", "accepted"]);

function sub(t: Task): string {
  if (t.status === "open")
    return t.assignee ? `For ${shortName(t.assignee)}` : "Anyone can take it";
  if (t.claimant) return shortName(t.claimant);
  return `Posted by ${shortName(t.lead)}`;
}

/** Task rows: title, who, status and amount; each opens its task page. */
export function TaskList({
  budgetId,
  tasks,
  meta,
}: {
  budgetId: string;
  tasks: [string, Task][];
  meta: TokenMeta;
}) {
  return (
    <Card className="divide-y divide-line">
      {tasks.map(([id, t]) => {
        const s = TASK_STATUS[t.status];
        return (
          <Link
            key={id}
            href={`/budgets/${budgetId}/tasks/${id}`}
            className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{t.title}</span>
              <span className="block text-sm text-muted">{sub(t)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <Pill tone={s.tone}>{s.label}</Pill>
              <span className="tabular font-semibold">{money(t.amount, meta)}</span>
            </span>
          </Link>
        );
      })}
    </Card>
  );
}
