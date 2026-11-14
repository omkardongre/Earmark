"use client";

import { type ReactNode, useState } from "react";
import { txUrl } from "@/lib/config";
import { BLOCKED, units } from "@/lib/format";
import type { BlockReason } from "@/lib/types";
import { Button, Card } from "./ui";

type Result = {
  ok: boolean;
  status?: string | null;
  reason?: string;
  tx?: string;
  requestId?: string;
  amount?: string;
  race?: Omit<Result, "ms">[];
  available?: string;
  error?: string;
  ms: number;
};

const tusdc = (amount: string) => `${units(amount, { symbol: "tUSDC", decimals: 6 })} tUSDC`;

const REFUSED: Record<string, string> = {
  key_not_allowed: "NEAR refused the transaction: this key can only ask for payments.",
  race_busy: "Someone just ran this. Try again in a minute.",
};
const reasonText = (r: string) => REFUSED[r] ?? BLOCKED[r as BlockReason] ?? r.replaceAll("_", " ");

async function run(scene: string, requestId?: string): Promise<Result> {
  const t = performance.now();
  try {
    const res = await fetch("/api/try", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene, requestId }),
    });
    const body = await res.json();
    return { ...body, ok: res.ok && body.ok, ms: performance.now() - t };
  } catch {
    return { ok: false, error: "Couldn't reach the server.", ms: 0 };
  }
}

/** One action: a button, then what the contract answered. */
function useAction(scene: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const go = async (requestId?: string) => {
    setBusy(true);
    setResult(null);
    const r = await run(scene, requestId);
    setResult(r);
    setBusy(false);
    return r;
  };
  return { busy, result, go, reset: () => setResult(null) };
}

function Answer({ r, okText }: { r: Result; okText: string }) {
  if (r.error) return <p className="text-sm font-medium text-rose-700">{r.error}</p>;
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-3.5 py-2.5 text-sm ring-1 ring-inset ${
        r.ok
          ? "bg-emerald-50 text-emerald-800 ring-emerald-600/15"
          : "bg-rose-50 text-rose-800 ring-rose-600/15"
      }`}
    >
      <span className="flex items-center gap-2 font-semibold">
        <Mark ok={r.ok} />
        {r.ok ? okText : `Refused: ${reasonText(r.reason ?? "failed")}`}
      </span>
      {r.ok && r.ms > 0 && (
        <span className="tabular text-emerald-700/70">{(r.ms / 1000).toFixed(1)} s</span>
      )}
      {r.tx && (
        <a
          href={txUrl(r.tx)}
          target="_blank"
          rel="noreferrer"
          className="ml-auto rounded-full bg-white/80 px-2.5 py-0.5 text-[13px] font-medium text-ink ring-1 ring-black/5 hover:text-brand"
        >
          View transaction ↗
        </a>
      )}
    </div>
  );
}
function Mark({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid size-5 shrink-0 place-items-center rounded-full text-white ${ok ? "bg-emerald-500" : "bg-rose-500"}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        className="size-3"
        aria-hidden
      >
        {ok ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <path d="M7 7l10 10M17 7L7 17" />}
      </svg>
    </span>
  );
}
/** Both racing requests: the first reserves the funds, the second is refused. */
function RaceAnswer({ r }: { r: Result }) {
  if (!r.race) return <Answer r={r} okText="Went through" />;
  const [first, second] = r.race;
  const amount = r.amount ? tusdc(r.amount) : "";
  return (
    <div className="space-y-1.5">
      {r.available && (
        <p className="text-sm text-muted">
          Two requests for {amount} each, {tusdc(r.available)} left.
        </p>
      )}
      {first && <Answer r={{ ...first, ms: 0 }} okText={`First: reserved ${amount}`} />}
      {second && <Answer r={{ ...second, ms: 0 }} okText="Second: also went through" />}
    </div>
  );
}
/** One step on the rail: a numbered dot that turns green once the step has run. */
function Step({
  n,
  title,
  text,
  done,
  last,
  children,
}: {
  n: number;
  title: string;
  text: ReactNode;
  done: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-4 sm:gap-5">
      {!last && (
        <span
          aria-hidden
          className="absolute left-4 top-10 -bottom-4 w-px bg-line sm:left-[1.125rem]"
        />
      )}
      <span
        className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold transition-colors sm:size-9 ${
          done
            ? "bg-emerald-500 text-white shadow-[0_4px_12px_-4px_rgb(16_185_129/70%)]"
            : "bg-white text-brand ring-1 ring-line"
        }`}
      >
        {done ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="size-4"
            aria-hidden
          >
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        ) : (
          n
        )}
      </span>
      <Card className="min-w-0 flex-1 space-y-4 p-5 sm:p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-muted">{text}</p>
        </div>
        {children}
      </Card>
    </li>
  );
}
/** `pay` and `ask` are the amounts the server sends, in token base units. */
export function TryPanel({ pay: payAmount, ask: askAmount }: { pay: string; ask: string }) {
  const pay = useAction("pay");
  const ask = useAction("ask");
  const approve = useAction("approve");
  const refusals = [
    {
      scene: "unknown",
      label: "Pay someone who isn't on the list",
      hint: "An AI agent would get this same key. It can only ask.",
    },
    { scene: "duplicate", label: "Pay for the same work twice" },
    { scene: "race", label: "Send two payments at once for the last funds" },
    { scene: "paused", label: "Pay while your spending is paused" },
    { scene: "lead-approves", label: "Approve your own request with the lead's key" },
  ] as const;
  const refusalActions = {
    unknown: useAction("unknown"),
    duplicate: useAction("duplicate"),
    race: useAction("race"),
    paused: useAction("paused"),
    "lead-approves": useAction("lead-approves"),
  };
  const pending = ask.result?.ok && ask.result.status === "pending_approval" ? ask.result : null;
  const tried = Object.values(refusalActions).filter((a) => a.result).length;
  return (
    <ol className="space-y-4">
      <Step
        n={1}
        title="Pay a contributor"
        text={`${tusdc(payAmount)} is inside your limit, so it pays at once.`}
        done={!!pay.result?.ok}
      >
        <Button disabled={pay.busy} onClick={() => pay.go()}>
          {pay.busy ? "Paying…" : `Pay ${tusdc(payAmount)}`}
        </Button>
        {pay.result && <Answer r={pay.result} okText="Paid" />}
      </Step>
      <Step
        n={2}
        title="Ask for more"
        text={`${tusdc(askAmount)} is above your limit, so one council member decides.`}
        done={!!approve.result?.ok}
      >
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={ask.busy}
            onClick={() => {
              approve.reset();
              ask.go();
            }}
          >
            {ask.busy ? "Asking…" : `Ask for ${tusdc(askAmount)}`}
          </Button>
          {pending && !approve.result?.ok && (
            <Button
              variant="secondary"
              disabled={approve.busy}
              onClick={() => approve.go(pending.requestId)}
            >
              {approve.busy ? "Approving…" : "Approve as a council member"}
            </Button>
          )}
        </div>
        {ask.result && <Answer r={ask.result} okText="Waiting for one approval" />}
        {approve.result && <Answer r={approve.result} okText="Approved and paid" />}
      </Step>
      <Step
        n={3}
        title="Try to break the rules"
        text="The contract checks every payment. The app can’t skip it."
        done={tried === refusals.length}
        last
      >
        <div className="flex items-center gap-3 text-sm text-muted">
          <div className="flex flex-1 gap-1" aria-hidden>
            {refusals.map((item) => (
              <span
                key={item.scene}
                className={`h-1.5 flex-1 rounded-full ${refusalActions[item.scene].result ? "bg-rose-400" : "bg-slate-200"}`}
              />
            ))}
          </div>
          <span className="tabular shrink-0 font-medium">
            {tried} of {refusals.length} tried
          </span>
        </div>
        <ul className="space-y-2.5">
          {refusals.map((item) => {
            const a = refusalActions[item.scene];
            return (
              <li
                key={item.scene}
                className={`space-y-3 rounded-xl p-4 ring-1 transition-colors ${a.result ? "bg-slate-50/70 ring-line" : "bg-white ring-line hover:ring-slate-300"}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{item.label}</p>
                    {"hint" in item && <p className="text-sm text-muted">{item.hint}</p>}
                  </div>
                  <Button
                    variant="secondary"
                    className="shrink-0"
                    disabled={a.busy}
                    onClick={() => a.go()}
                  >
                    {a.busy ? "Trying…" : a.result ? "Again" : "Try"}
                  </Button>
                </div>
                {a.result &&
                  (item.scene === "race" ? (
                    <RaceAnswer r={a.result} />
                  ) : (
                    <Answer r={a.result} okText="Went through" />
                  ))}
              </li>
            );
          })}
        </ul>
      </Step>
    </ol>
  );
}
