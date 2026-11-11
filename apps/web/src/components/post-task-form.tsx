"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { money, shortName, toBase } from "@/lib/format";
import type { TokenMeta } from "@/lib/types";
import { input } from "./setup-form";
import { Button } from "./ui";
import { useWallet } from "./wallet";

const MAX_TITLE = 100;
const MAX_LINK = 256;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * A lead posts a task. Its amount is set aside in the budget at once, so whoever takes it knows
 * the money is there.
 */
export function PostTaskForm({
  budgetId,
  spenders,
  payees,
  available,
  maxAmount,
  meta,
}: {
  budgetId: string;
  spenders: string[];
  /** Approved payees who aren't leads or approvers: who a task can be only for. */
  payees: string[];
  available: string;
  /** The one-approval limit: tasks are paid from the budget, never by a DAO vote. */
  maxAmount: string;
  meta: TokenMeta;
}) {
  const router = useRouter();
  const { accountId, connect, call } = useWallet();
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [brief, setBrief] = useState("");
  const [days, setDays] = useState("7");
  const [only, setOnly] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!accountId)
    return (
      <div className="space-y-3 text-center">
        <p className="text-muted">Sign in as a lead of this budget to post a task.</p>
        <Button onClick={() => void connect()}>Sign in</Button>
      </div>
    );
  if (!spenders.includes(accountId))
    return <p className="text-muted">Only a lead of this budget can post tasks.</p>;

  const base = toBase(amount, meta);
  const problem = !title.trim()
    ? "Give the task a title."
    : bytes(title.trim()) > MAX_TITLE
      ? "The title is too long."
      : !base
        ? "Enter the amount."
        : BigInt(base) > BigInt(maxAmount)
          ? `Tasks can be at most ${money(maxAmount, meta)}.`
          : BigInt(base) > BigInt(available)
            ? `Only ${money(available, meta)} is left in the budget.`
            : bytes(brief.trim()) > MAX_LINK
              ? "The brief link is too long."
              : null;

  const post = async () => {
    if (problem || !base) return;
    setBusy(true);
    setError(null);
    const r = await call(
      "post_task",
      {
        envelope_id: budgetId,
        title: title.trim(),
        brief: brief.trim(),
        amount: base,
        assignee: only || null,
        claim_days: Number(days),
      },
      { gasTgas: 30 },
    );
    setBusy(false);
    if (!r.ok) return setError(r.error);
    const id = typeof r.value === "string" ? r.value : null;
    router.push(id ? `/budgets/${budgetId}/tasks/${id}` : `/budgets/${budgetId}/tasks`);
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void post();
      }}
    >
      <label className="block space-y-1.5">
        <span className="font-medium">What needs doing</span>
        <input
          className={input}
          placeholder="Write the setup guide"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={MAX_TITLE}
        />
      </label>

      <label className="block">
        <span className="sr-only">Amount</span>
        <span className="flex items-baseline justify-center gap-2 rounded-2xl bg-surface px-4 py-5 focus-within:ring-2 focus-within:ring-brand/30">
          <input
            className="tabular w-full min-w-0 bg-transparent text-center text-4xl font-bold tracking-tight outline-none placeholder:text-slate-300"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="text-lg font-semibold text-muted">{meta.symbol}</span>
        </span>
        <span className="mt-1.5 block text-center text-sm text-muted">
          {money(available, meta)} left in the budget
        </span>
      </label>

      <label className="block space-y-1.5">
        <span className="font-medium">Link to the brief</span>
        <input
          className={input}
          placeholder="https:// (optional)"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>

      <details className="rounded-xl border border-line px-4 py-3">
        <summary className="font-medium text-brand">More options</summary>
        <div className="mt-4 space-y-4">
          <label className="block space-y-1.5">
            <span className="font-medium">Days to finish once someone takes it</span>
            <select className={input} value={days} onChange={(e) => setDays(e.target.value)}>
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} {d === 1 ? "day" : "days"}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="font-medium">Only for</span>
            <select className={input} value={only} onChange={(e) => setOnly(e.target.value)}>
              <option value="">Anyone who can be paid from this budget</option>
              {payees.map((p) => (
                <option key={p} value={p}>
                  {shortName(p)} ({p})
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>

      {(error || (problem && (title || amount))) && (
        <p className="text-sm text-rose-700" role="alert">
          {error ?? problem}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy || !!problem}>
        {busy
          ? "Confirm in your wallet…"
          : base && !problem
            ? `Post and set aside ${amount.trim()} ${meta.symbol}`
            : "Post task"}
      </Button>
      <p className="text-center text-sm text-muted">
        The money stays in the budget until you accept the work, and comes back if you cancel.
      </p>
    </form>
  );
}
