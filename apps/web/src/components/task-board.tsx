"use client";
import { useState } from "react";
import { money } from "@/lib/format";
import type { Task, TaskRules, TokenMeta } from "@/lib/types";
import { type Team, useRole } from "./roles";
import { ACTIVE, TaskList } from "./task-list";
import { ButtonLink, Empty } from "./ui";

type Tab = "open" | "doing" | "paid";

/** "Post a task", only for a lead of the budget. */
export function PostTaskButton({
  budgetId,
  team,
  variant = "primary",
  children = "Post a task",
}: {
  budgetId: string;
  team: Team;
  variant?: "primary" | "secondary";
  children?: string;
}) {
  const { role } = useRole(team);
  if (role !== "lead") return null;
  return (
    <ButtonLink href={`/budgets/${budgetId}/tasks/new`} variant={variant}>
      {children}
    </ButtonLink>
  );
}

/** No tasks to show: a lead gets the button to post one, everyone else one plain line. */
export function TasksEmpty({
  budgetId,
  team,
  first,
  canPost,
}: {
  budgetId: string;
  team: Team;
  /** The budget has never had a task. */
  first: boolean;
  canPost: boolean;
}) {
  const { role } = useRole(team);
  if (role === "lead" && canPost)
    return (
      <Empty action={<PostTaskButton budgetId={budgetId} team={team} />}>
        {first ? "No tasks yet. Post one and the money is set aside for it." : "No open tasks."}
      </Empty>
    );
  return <Empty>No open tasks right now.</Empty>;
}

/** One short line for contributors on how trust works here, when the DAO turned it on. */
export function TrustLine({
  rules,
  meta,
  team,
}: {
  rules: TaskRules;
  meta: TokenMeta;
  team: Team;
}) {
  const { role } = useRole(team);
  if (BigInt(rules.trusted_limit) === 0n || role === "lead" || role === "approver") return null;
  const n = rules.min_tasks;
  const over = rules.min_days > 0 ? ` over ${rules.min_days} days` : "";
  return (
    <p className="text-sm text-muted">
      Do {n} {n === 1 ? "task" : "tasks"} well here{over} and later payments come faster, up to{" "}
      {money(rules.trusted_limit, meta)}.
    </p>
  );
}

/** The board: Open, In progress and Paid as tabs with counts, so nothing shows an empty box. */
export function TaskBoard({
  budgetId,
  tasks,
  meta,
  team,
  canPost,
}: {
  budgetId: string;
  tasks: [string, Task][];
  meta: TokenMeta;
  team: Team;
  canPost: boolean;
}) {
  const lists: Record<Tab, [string, Task][]> = {
    open: tasks.filter(([, t]) => t.status === "open"),
    doing: tasks.filter(([, t]) => ACTIVE.has(t.status) && t.status !== "open"),
    paid: tasks.filter(([, t]) => t.status === "paid"),
  };
  const tabs: { key: Tab; label: string }[] = [
    { key: "open", label: "Open" },
    { key: "doing", label: "In progress" },
    { key: "paid", label: "Paid" },
  ];
  const [tab, setTab] = useState<Tab>(
    () => tabs.find((t) => lists[t.key].length > 0)?.key ?? "open",
  );
  const shown = lists[tab];
  return (
    <div className="space-y-4">
      <div className="flex gap-1.5" role="tablist" aria-label="Tasks">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 ring-inset ${
              tab === t.key
                ? "bg-ink text-white ring-ink"
                : "bg-white text-muted ring-line hover:text-ink"
            }`}
          >
            {t.label} <span className="tabular opacity-70">{lists[t.key].length}</span>
          </button>
        ))}
      </div>
      {shown.length > 0 ? (
        <TaskList budgetId={budgetId} tasks={shown} meta={meta} />
      ) : tab === "open" ? (
        <TasksEmpty budgetId={budgetId} team={team} first={tasks.length === 0} canPost={canPost} />
      ) : (
        <Empty>{tab === "doing" ? "Nothing in progress." : "No paid tasks yet."}</Empty>
      )}
    </div>
  );
}
