"use client";

import { useEffect, useRef, useState } from "react";
import { CONTRACT, NETWORK } from "@/lib/config";
import { BLOCKED, shortName, toBase } from "@/lib/format";
import { view } from "@/lib/near";
import type { BlockReason, Tier, TokenMeta } from "@/lib/types";
import { Pill, type Tone } from "./ui";

type Check = { tier: Tier | null; blocked: BlockReason | null };

/** Not on any budget's payee list: shows what happens to an unknown account. */
const SOMEONE = NETWORK === "mainnet" ? "someone-else.near" : "someone-else.testnet";

const TIER: Record<Tier, { label: string; hint: string; tone: Tone }> = {
  auto: { label: "Pays now", hint: "Within the lead’s own limit.", tone: "green" },
  one_approver: {
    label: "Needs one approval",
    hint: "One council member signs, then it pays.",
    tone: "amber",
  },
  escalate: { label: "DAO vote", hint: "Too big for the budget: the DAO decides.", tone: "blue" },
  trusted: {
    label: "Pays now",
    hint: "A trusted contributor: no approval needed up to the budget’s trusted limit.",
    tone: "green",
  },
};

const RESULT_BG: Partial<Record<Tone, string>> = {
  green: "bg-emerald-50/70",
  amber: "bg-amber-50/70",
  blue: "bg-sky-50/70",
};

/** Plainer words for a visitor than the lead-facing `BLOCKED` text. */
const WHY: Partial<Record<BlockReason, string>> = {
  payee_not_allowed: "Not an approved payee. The council adds payees first.",
  over_period_cap: "Over the lead’s limit for this period.",
  paused: "Payments from this budget are paused.",
};

// A fresh request and work id per page view, so "already paid" never trips the demo.
const rand = () => Math.random().toString(36).slice(2, 10);

/**
 * Amount + payee -> which path the payment takes, from the demo budget's real `check_spend`
 * view for one of its leads. Read-only: no wallet, nothing is sent.
 */
export function RoutePicker({
  budgetId,
  lead,
  payees,
  meta,
}: {
  budgetId: string;
  lead: string;
  payees: string[];
  meta: TokenMeta;
}) {
  const [amount, setAmount] = useState("5");
  const [payee, setPayee] = useState(payees[0] ?? SOMEONE);
  const [check, setCheck] = useState<Check | null>(null);
  const [failed, setFailed] = useState(false);
  const ids = useRef<{ request: string; work: string } | null>(null);
  const base = toBase(amount, meta);

  useEffect(() => {
    setCheck(null);
    setFailed(false);
    if (!base) return;
    ids.current ??= { request: `try-${rand()}`, work: `route-picker-${rand()}` };
    const { request, work } = ids.current;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const c = await view<Check>(CONTRACT, "check_spend", {
          envelope_id: budgetId,
          spender: lead,
          request_id: request,
          payee,
          amount: base,
          work_ref: work,
        });
        if (live) setCheck(c);
      } catch {
        if (live) setFailed(true);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [base, payee, budgetId, lead]);

  const tier = check?.tier ? TIER[check.tier] : null;
  const choices = [...payees.slice(0, 4), SOMEONE];

  return (
    <div className="space-y-4 rounded-3xl border border-line bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">What happens to a payment?</p>
          <p className="text-sm text-muted">Asked to the live contract.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
          <span className="relative flex size-1.5">
            <span className="live-ping absolute inline-flex size-full rounded-full bg-emerald-500" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          Live
        </span>
      </div>

      <label className="flex items-baseline gap-2 rounded-2xl bg-surface px-4 py-3.5 ring-1 ring-line focus-within:ring-2 focus-within:ring-brand/40">
        <span className="sr-only">Amount</span>
        <input
          className="tabular w-full min-w-0 bg-transparent text-3xl font-semibold tracking-tight outline-none placeholder:text-slate-300"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <span className="font-semibold text-muted">{meta.symbol}</span>
      </label>

      <fieldset className="flex flex-wrap gap-1.5">
        <legend className="mb-1.5 text-sm font-medium text-muted">To</legend>
        {choices.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={payee === p}
            title={p === SOMEONE ? "An account that isn’t an approved payee" : p}
            onClick={() => setPayee(p)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 ring-inset ${
              payee === p
                ? "bg-ink text-white ring-ink"
                : "bg-white text-muted ring-line hover:text-ink"
            }`}
          >
            {p === SOMEONE ? "Someone else" : shortName(p)}
          </button>
        ))}
      </fieldset>

      <div
        className={`min-h-16 rounded-2xl px-4 py-3 transition-colors ${
          check?.blocked ? "bg-rose-50" : tier ? RESULT_BG[tier.tone] : "bg-surface"
        }`}
        aria-live="polite"
      >
        {!base ? (
          <p className="text-sm text-muted">Enter an amount.</p>
        ) : failed ? (
          <p className="text-sm text-muted">Couldn’t reach the contract. Try again in a moment.</p>
        ) : check?.blocked ? (
          <p className="flex flex-col items-start gap-1.5">
            <Pill tone="red">Blocked</Pill>
            <span className="text-[15px] text-muted">
              {WHY[check.blocked] ?? BLOCKED[check.blocked]}
            </span>
          </p>
        ) : tier ? (
          <p className="flex flex-col items-start gap-1.5">
            <Pill tone={tier.tone}>{tier.label}</Pill>
            <span className="text-[15px] text-muted">{tier.hint}</span>
          </p>
        ) : (
          <p className="text-sm text-muted">Checking…</p>
        )}
      </div>
    </div>
  );
}
