"use client";

import { type ReactNode, useState } from "react";
import { accountExists, type EnvelopeInput, maxBig, validAccountId } from "@/lib/dao";
import { money, shortName, toBase, units } from "@/lib/format";
import type { TokenMeta } from "@/lib/types";
import { Avatar } from "./ui";

/** `key` only keeps rows stable in the list. */
export type Lead = { key: number; account: string; auto: string };

export type BudgetForm = {
  name: string;
  token: string;
  amount: string;
  period: string;
  leads: Lead[];
  oneApproval: string;
  approvers: string[];
  payees: string[];
};

export type FormErrors = Partial<Record<keyof BudgetForm, string>>;

export const PERIODS = [
  { secs: "604800", label: "week" },
  { secs: "2592000", label: "month" },
  { secs: "7776000", label: "quarter" },
];

/** Input look without a width, for rows that size their own fields. */
const field =
  "h-11.5 min-w-0 rounded-xl border border-slate-300 bg-white px-3.5 outline-none focus:border-brand focus:ring-4 focus:ring-brand/20";
export const input = `${field} w-full`;

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Checks the form against the contract's rules (envelope.rs) and builds `create_envelope` input.
 * Then confirms every account exists. Messages are for the person filling the form.
 */
export async function checkBudget(
  f: BudgetForm,
  meta: TokenMeta,
): Promise<{ errors: FormErrors; envelope?: EnvelopeInput }> {
  const errors: FormErrors = {};
  const name = f.name.trim();
  if (!name) errors.name = "Give the budget a name.";
  else if (bytes(name) > 64) errors.name = "Use a shorter name (64 characters at most).";

  const amount = toBase(f.amount, meta);
  if (!amount) errors.amount = `Enter an amount in ${meta.symbol}.`;
  const one = toBase(f.oneApproval, meta);
  if (!one) errors.oneApproval = `Enter an amount in ${meta.symbol}.`;
  else if (amount && BigInt(one) > BigInt(amount))
    errors.oneApproval = `Can't be more than the budget (${money(amount, meta)}).`;

  const leads = f.leads
    .map((l) => ({ account: l.account.trim().toLowerCase(), auto: l.auto }))
    .filter((l) => l.account);
  const leadIssues: string[] = [];
  if (leads.length === 0) leadIssues.push("Add at least one lead.");
  if (leads.length > 50) leadIssues.push("At most 50 leads.");
  if (new Set(leads.map((l) => l.account)).size < leads.length)
    leadIssues.push("A lead is listed twice.");
  const autos: bigint[] = [];
  for (const l of leads) {
    if (!validAccountId(l.account)) leadIssues.push(`“${l.account}” isn't a NEAR account name.`);
    const a = toBase(l.auto, meta);
    if (!a) leadIssues.push(`Set how much ${l.account} can pay at once.`);
    else if (one && BigInt(a) > BigInt(one))
      leadIssues.push(
        `${l.account} can pay at most the one-approval limit (${money(one, meta)}) at once.`,
      );
    else autos.push(BigInt(a));
  }
  if (leadIssues[0]) errors.leads = leadIssues[0];

  if (f.approvers.length === 0) errors.approvers = "Add at least one approver.";
  else if (f.approvers.length > 10) errors.approvers = "At most 10 approvers.";
  else if (f.approvers.length === 1 && leads.some((l) => l.account === f.approvers[0]))
    errors.approvers = "Add another approver: a lead can't approve their own payments.";

  if (f.payees.length === 0) errors.payees = "Add at least one person who can be paid.";
  else if (f.payees.length > 200) errors.payees = "At most 200 payees.";

  if (Object.keys(errors).length || !amount || !one) return { errors };

  const all = [...new Set([...leads.map((l) => l.account), ...f.approvers, ...f.payees])];
  const exists = await Promise.all(all.map((a) => accountExists(a).catch(() => true)));
  const missing = new Set(all.filter((_, i) => !exists[i]));
  const notFound = (list: string[], key: "leads" | "approvers" | "payees") => {
    const m = list.filter((a) => missing.has(a));
    if (m.length) errors[key] = `${m.join(", ")} ${m.length === 1 ? "doesn't" : "don't"} exist.`;
  };
  notFound(
    leads.map((l) => l.account),
    "leads",
  );
  notFound(f.approvers, "approvers");
  notFound(f.payees, "payees");
  if (Object.keys(errors).length) return { errors };

  const half = BigInt(one) / 2n;
  return {
    errors,
    envelope: {
      name,
      token_id: f.token,
      spenders: leads.map((l) => ({
        account_id: l.account,
        auto_limit: toBase(l.auto, meta) as string,
        period_cap: amount,
      })),
      approvers: f.approvers,
      one_approver_limit: one,
      // Approvers may later raise a lead's limit up to half the approval limit (after a delay).
      raise_ceiling: maxBig(half, ...autos).toString(),
      payees: f.payees,
      period_secs: f.period,
      period_cap: amount,
    },
  };
}

export function SetupForm({
  value,
  onChange,
  errors,
  tokens,
  approverRole,
}: {
  value: BudgetForm;
  onChange: (f: BudgetForm) => void;
  errors: FormErrors;
  tokens: Record<string, TokenMeta>;
  approverRole: string | null;
}) {
  const set = <K extends keyof BudgetForm>(k: K, v: BudgetForm[K]) =>
    onChange({ ...value, [k]: v });
  const meta = tokens[value.token];
  const symbol = meta?.symbol ?? "";
  const setLead = (i: number, l: Partial<Lead>) =>
    set(
      "leads",
      value.leads.map((x, j) => (j === i ? { ...x, ...l } : x)),
    );

  return (
    <div className="space-y-5">
      <Field label="Budget name" error={errors.name}>
        <input
          className={input}
          placeholder="e.g. News contributors"
          value={value.name}
          maxLength={64}
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
        <Field label="Amount to fund" error={errors.amount}>
          <div className="flex gap-2">
            <input
              className={`${input} tabular`}
              inputMode="decimal"
              placeholder="500"
              value={value.amount}
              onChange={(e) => set("amount", e.target.value)}
            />
            {Object.keys(tokens).length > 1 ? (
              <select
                className={field}
                aria-label="Token"
                value={value.token}
                onChange={(e) => set("token", e.target.value)}
              >
                {Object.entries(tokens).map(([id, m]) => (
                  <option key={id} value={id}>
                    {m.symbol}
                  </option>
                ))}
              </select>
            ) : (
              <span className="grid place-items-center px-1 font-medium text-muted">{symbol}</span>
            )}
          </div>
        </Field>
        <Field label="Resets every">
          <select
            className={`${field} w-full sm:w-36`}
            value={value.period}
            onChange={(e) => set("period", e.target.value)}
          >
            {PERIODS.map((p) => (
              <option key={p.secs} value={p.secs}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="Leads"
        hint="Who pays from the budget. Above their limit, a payment needs approval."
        error={errors.leads}
      >
        <div className="space-y-2">
          {value.leads.map((l, i) => (
            <div key={l.key} className="flex flex-wrap items-center gap-2">
              <input
                className={`${field} min-w-48 flex-1`}
                placeholder="lead.near"
                aria-label={`Lead ${i + 1}`}
                value={l.account}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setLead(i, { account: e.target.value })}
              />
              <span className="flex items-center gap-2 text-sm text-muted">
                pays up to
                <input
                  className={`${field} tabular w-20 shrink-0 text-base text-ink`}
                  inputMode="decimal"
                  aria-label={`Pays at once without approval, lead ${i + 1} (${symbol})`}
                  value={l.auto}
                  onChange={(e) => setLead(i, { auto: e.target.value })}
                />
                {symbol} at once
              </span>
              <button
                type="button"
                className="shrink-0 px-2 text-xl text-subtle hover:text-ink disabled:invisible"
                aria-label={`Remove lead ${i + 1}`}
                disabled={value.leads.length === 1}
                onClick={() =>
                  set(
                    "leads",
                    value.leads.filter((_, j) => j !== i),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-sm font-medium text-brand hover:underline"
            onClick={() =>
              set("leads", [
                ...value.leads,
                { key: Date.now(), account: "", auto: value.leads[0]?.auto ?? "" },
              ])
            }
          >
            + Add lead
          </button>
        </div>
      </Field>

      <Field
        label="Needs one approval up to"
        hint="Bigger payments go to a DAO vote."
        error={errors.oneApproval}
      >
        <div className="flex items-center gap-2">
          <input
            className={`${input} tabular sm:w-40`}
            inputMode="decimal"
            value={value.oneApproval}
            onChange={(e) => set("oneApproval", e.target.value)}
          />
          <span className="font-medium text-muted">{symbol}</span>
        </div>
      </Field>

      <Field
        label="Approvers"
        hint={
          approverRole
            ? `From the DAO's ${approverRole} role. Any one of them can approve.`
            : "Any one of them can approve."
        }
        error={errors.approvers}
      >
        <AccountList
          value={value.approvers}
          onChange={(v) => set("approvers", v)}
          placeholder="Add approver"
        />
      </Field>

      <Field
        label="Who can be paid"
        hint="Only these accounts can receive payments."
        error={errors.payees}
      >
        <AccountList
          value={value.payees}
          onChange={(v) => set("payees", v)}
          placeholder="Add payee"
        />
      </Field>

      {meta && toBase(value.amount, meta) && (
        <p className="text-sm text-muted">
          Leads can pay out up to {units(toBase(value.amount, meta) as string, meta)} {symbol} per{" "}
          {PERIODS.find((p) => p.secs === value.period)?.label}.
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="block space-y-1.5">
      <span className="block font-medium">{label}</span>
      {hint && <span className="block text-sm text-muted">{hint}</span>}
      {children}
      {error && (
        <span className="block text-sm text-rose-700" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Account chips with an input; Enter, comma, space or leaving the field adds what's typed. */
function AccountList({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const ids = draft
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (ids.length) onChange([...new Set([...value, ...ids])]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-300 bg-white p-2 focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/20">
      {value.map((a) => (
        <span
          key={a}
          title={a}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-full py-1 pr-1 pl-1.5 text-sm ${
            validAccountId(a) ? "bg-slate-100" : "bg-rose-50 text-rose-700"
          }`}
        >
          <Avatar id={a} />
          <span className="truncate">{validAccountId(a) ? shortName(a) : a}</span>
          <button
            type="button"
            className="grid size-5 place-items-center rounded-full text-subtle hover:bg-slate-200 hover:text-ink"
            aria-label={`Remove ${a}`}
            onClick={() => onChange(value.filter((x) => x !== a))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="h-8 min-w-32 flex-1 bg-transparent px-1.5 outline-none"
        placeholder={placeholder}
        aria-label={placeholder}
        value={draft}
        autoCapitalize="none"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === " ") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
  );
}
