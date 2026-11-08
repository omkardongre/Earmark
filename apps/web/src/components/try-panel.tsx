"use client";

import { type ReactNode, useState } from "react";
import { txUrl } from "@/lib/config";
import { BLOCKED } from "@/lib/format";
import type { BlockReason } from "@/lib/types";
import { Button, Card, ExternalLink } from "./ui";

type Result = {
  ok: boolean;
  status?: string | null;
  reason?: string;
  tx?: string;
  requestId?: string;
  error?: string;
  ms: number;
};

const REFUSED: Record<string, string> = {
  key_not_allowed: "NEAR refused the transaction: this key can only ask for payments.",
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
  if (r.error) return <p className="text-rose-700">{r.error}</p>;
  return (
    <p
      className={`flex flex-wrap items-center gap-x-3 ${r.ok ? "text-emerald-700" : "text-rose-700"}`}
    >
      <span className="font-medium">
        {r.ok ? `✓ ${okText}` : `✕ Refused: ${reasonText(r.reason ?? "failed")}`}
      </span>
      {r.ok && <span className="text-muted">{(r.ms / 1000).toFixed(1)} s</span>}
      {r.tx && <ExternalLink href={txUrl(r.tx)}>View transaction</ExternalLink>}
    </p>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card className="space-y-4 p-6">
      <h2 className="flex items-center gap-3 text-lg font-semibold">
        <span className="grid size-7 place-items-center rounded-full bg-brand-soft text-sm text-brand">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

export function TryPanel() {
  const pay = useAction("pay");
  const ask = useAction("ask");
  const approve = useAction("approve");
  const refusals = [
    { scene: "unknown", label: "Pay someone who isn't on the list" },
    { scene: "duplicate", label: "Pay for the same work twice" },
    { scene: "lead-approves", label: "Approve your own request with the lead's key" },
  ] as const;
  const unknown = useAction("unknown");
  const duplicate = useAction("duplicate");
  const leadApproves = useAction("lead-approves");
  const refusalActions = { unknown, duplicate, "lead-approves": leadApproves };
  const pending = ask.result?.ok && ask.result.status === "pending_approval" ? ask.result : null;

  return (
    <div className="space-y-4">
      <Step n={1} title="Pay a contributor">
        <p className="text-muted">3 tUSDC is inside your limit, so it pays at once.</p>
        <Button disabled={pay.busy} onClick={() => pay.go()}>
          {pay.busy ? "Paying…" : "Pay 3 tUSDC"}
        </Button>
        {pay.result && <Answer r={pay.result} okText="Paid" />}
      </Step>

      <Step n={2} title="Ask for more">
        <p className="text-muted">20 tUSDC is above your limit, so one council member decides.</p>
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={ask.busy}
            onClick={() => {
              approve.reset();
              ask.go();
            }}
          >
            {ask.busy ? "Asking…" : "Ask for 20 tUSDC"}
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

      <Step n={3} title="Try to break the rules">
        <p className="text-muted">The contract checks every payment. The app can’t skip it.</p>
        <div className="divide-y divide-line rounded-xl ring-1 ring-line">
          {refusals.map(({ scene, label }) => {
            const a = refusalActions[scene];
            return (
              <div key={scene} className="space-y-2 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span>{label}</span>
                  <Button variant="secondary" disabled={a.busy} onClick={() => a.go()}>
                    {a.busy ? "Trying…" : "Try"}
                  </Button>
                </div>
                {a.result && <Answer r={a.result} okText="Went through" />}
              </div>
            );
          })}
        </div>
      </Step>
    </div>
  );
}
