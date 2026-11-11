"use client";

import Link from "next/link";
import { useState } from "react";
import { shortName } from "@/lib/format";
import { MAX_NOTE, type PayPrefill, prefillProblem, requestPath } from "@/lib/request-link";
import type { TokenMeta } from "@/lib/types";
import { input } from "./setup-form";
import { Avatar, Button, ButtonLink } from "./ui";
import { useWallet } from "./wallet";

/**
 * The contributor's side of a payment: amount, work link and note become one link for the lead.
 * No wallet needed; signed in as a payee, "who you are" is picked already.
 */
export function RequestForm({
  budgetId,
  budgetName,
  payees,
  meta,
}: {
  budgetId: string;
  budgetName: string;
  payees: string[];
  meta: TokenMeta;
}) {
  const { accountId } = useWallet();
  const mine = accountId && payees.includes(accountId) ? accountId : "";
  const [picked, setPicked] = useState("");
  const [amount, setAmount] = useState("");
  const [work, setWork] = useState("");
  const [memo, setMemo] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const payee = picked || mine;
  const draft: PayPrefill = { payee, amount: amount.trim(), work: work.trim(), memo: memo.trim() };

  const make = () => {
    const p = prefillProblem(draft, meta);
    setProblem(p);
    if (!p) setLink(`${window.location.origin}${requestPath(budgetId, draft)}`);
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setProblem("Couldn’t copy. Select the link and copy it.");
    }
  };
  const share = async () => {
    if (!link) return;
    try {
      await navigator.share({ title: `Payment request: ${budgetName}`, url: link });
    } catch {
      // Closed the share sheet: nothing to do.
    }
  };
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  if (link)
    return (
      <div className="space-y-5">
        <div className="rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 px-5 py-6 text-white">
          <p className="text-lg font-semibold">
            Your request for {draft.amount} {meta.symbol} is ready
          </p>
          <p className="text-white/85">
            Send this link to your lead. It opens their pay form, filled in.
          </p>
        </div>
        <input
          readOnly
          className={`${input} text-sm text-muted`}
          value={link}
          aria-label="Request link"
          onFocus={(e) => e.currentTarget.select()}
        />
        {problem && <p className="text-sm text-rose-700">{problem}</p>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={copy}>{copied ? "Copied" : "Copy link"}</Button>
          {canShare && (
            <Button variant="secondary" onClick={share}>
              Share
            </Button>
          )}
          <Button variant="ghost" onClick={() => setLink(null)}>
            Edit
          </Button>
        </div>
        <p className="text-sm text-muted">
          Once it’s paid, it shows on{" "}
          <Link href={`/people/${payee}`} className="font-medium text-brand hover:underline">
            your page
          </Link>{" "}
          with a receipt.
        </p>
      </div>
    );

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        make();
      }}
    >
      {!mine && (
        <fieldset className="space-y-1.5">
          <legend className="font-medium">Who you are</legend>
          <div className="divide-y divide-line rounded-xl border border-slate-300">
            {payees.map((p) => (
              <label
                key={p}
                className={`flex cursor-pointer items-center gap-3 px-3.5 py-2.5 hover:bg-slate-50 ${
                  payee === p ? "bg-brand-soft" : ""
                }`}
              >
                <input
                  type="radio"
                  name="payee"
                  value={p}
                  checked={payee === p}
                  onChange={() => setPicked(p)}
                  className="size-4 accent-brand"
                />
                <Avatar id={p} />
                <span className="min-w-0">
                  <span className="block font-medium">{shortName(p)}</span>
                  <span className="block break-all text-sm text-muted">{p}</span>
                </span>
              </label>
            ))}
          </div>
          <span className="block text-sm text-muted">Not listed? Ask an approver to add you.</span>
        </fieldset>
      )}

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
      </label>

      <label className="block space-y-1.5">
        <span className="font-medium">Link to the work</span>
        <input
          className={input}
          placeholder="https://"
          value={work}
          onChange={(e) => setWork(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>

      <label className="block space-y-1.5">
        <span className="font-medium">Note</span>
        <input
          className={input}
          placeholder="What it’s for (optional)"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={MAX_NOTE}
        />
      </label>

      {problem && (
        <p className="text-sm text-rose-700" role="alert">
          {problem}
        </p>
      )}
      <Button type="submit" className="w-full">
        Get request link
      </Button>
    </form>
  );
}

/** For a signed-in payee on a budget page: where to ask for a payment. */
export function AskButton({
  budgetId,
  payees,
  spenders,
}: {
  budgetId: string;
  payees: string[];
  spenders: string[];
}) {
  const { accountId } = useWallet();
  if (!accountId || !payees.includes(accountId) || spenders.includes(accountId)) return null;
  return <ButtonLink href={`/budgets/${budgetId}/request`}>Ask to be paid</ButtonLink>;
}
