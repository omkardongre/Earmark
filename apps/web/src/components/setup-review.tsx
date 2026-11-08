"use client";

import { useState } from "react";
import { proposalUrl, txUrl } from "@/lib/config";
import { canPropose, type DaoPolicy, type KindLabel } from "@/lib/dao";
import { Button, Card, ExternalLink, Pill } from "./ui";
import { useWallet } from "./wallet";

/** One DAO proposal the setup files: plain words for people, exact args for checking. */
export type PlannedProposal = {
  key: string;
  title: string;
  lines: string[];
  label: KindLabel;
  proposal: { description: string; kind: object };
  /** Readable form of base64 call args, shown next to the exact JSON. */
  decoded?: object;
};

type Sent = { id: number; hash: string };
type State = { status: "idle" | "signing" | "error"; error?: string } | ({ status: "done" } & Sent);

export const nearAmount = (yocto: string) => {
  const milli = Number(BigInt(yocto) / 10n ** 21n);
  return `${(milli / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} NEAR`;
};

/** Files each proposal with the connected wallet, in order; a failed one can be retried. */
export function SetupReview({
  dao,
  policy,
  plan,
  later,
  onBack,
  onSent,
}: {
  dao: string;
  policy: DaoPolicy;
  plan: PlannedProposal[];
  /** A step that can only be filed after these pass (funding). */
  later: string;
  onBack: () => void;
  onSent: (sent: Record<string, Sent>) => void;
}) {
  const { accountId, connect, call } = useWallet();
  const [states, setStates] = useState<Record<string, State>>({});
  const [busy, setBusy] = useState(false);
  const blocked = accountId ? plan.filter((p) => !canPropose(policy, accountId, p.label)) : [];
  const bond = BigInt(policy.proposal_bond);
  const allDone = plan.every((p) => states[p.key]?.status === "done");

  async function submit() {
    setBusy(true);
    const sent: Record<string, Sent> = {};
    for (const p of plan) {
      const s = states[p.key];
      if (s?.status === "done") {
        sent[p.key] = { id: s.id, hash: s.hash };
        continue;
      }
      setStates((m) => ({ ...m, [p.key]: { status: "signing" } }));
      const r = await call(
        "add_proposal",
        { proposal: p.proposal },
        { receiverId: dao, gasTgas: 50, deposit: policy.proposal_bond },
      );
      if (!r.ok) {
        setStates((m) => ({ ...m, [p.key]: { status: "error", error: r.error } }));
        setBusy(false);
        return;
      }
      sent[p.key] = { id: Number(r.value), hash: r.hash };
      setStates((m) => ({ ...m, [p.key]: { status: "done", id: Number(r.value), hash: r.hash } }));
    }
    setBusy(false);
    onSent(sent);
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Review</h2>
        <p className="text-muted">
          You’ll file {plan.length === 1 ? "one proposal" : `${plan.length} proposals`} in{" "}
          <span className="font-medium text-ink">{dao}</span>.{" "}
          {plan.length === 1
            ? "Your council votes on it; the budget appears after it passes."
            : "Your council votes on them; the budget appears after they pass."}
        </p>
      </div>

      <ol className="space-y-3">
        {plan.map((p, i) => {
          const s = states[p.key];
          return (
            <li key={p.key}>
              <Card className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold">
                    {i + 1}. {p.title}
                  </p>
                  {s?.status === "signing" && <Pill tone="blue">Confirm in wallet</Pill>}
                  {s?.status === "done" && <Pill tone="green">Filed · #{s.id}</Pill>}
                  {s?.status === "error" && <Pill tone="red">Not filed</Pill>}
                </div>
                <ul className="list-disc space-y-0.5 pl-5 text-muted">
                  {p.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
                {s?.status === "error" && <p className="text-sm text-rose-700">{s.error}</p>}
                {s?.status === "done" && (
                  <p className="flex gap-4 text-sm">
                    <ExternalLink href={proposalUrl(dao, s.id)}>Open proposal</ExternalLink>
                    <ExternalLink href={txUrl(s.hash)}>Transaction</ExternalLink>
                  </p>
                )}
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted hover:text-ink">Details</summary>
                  <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-relaxed">
                    {JSON.stringify(
                      {
                        receiver: dao,
                        method: "add_proposal",
                        deposit: policy.proposal_bond,
                        gas: "50000000000000",
                        args: { proposal: p.proposal },
                      },
                      null,
                      2,
                    )}
                    {p.decoded && `\n\n// args, decoded\n${JSON.stringify(p.decoded, null, 2)}`}
                  </pre>
                </details>
              </Card>
            </li>
          );
        })}
        <li>
          <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-4 text-muted">
            <span className="font-semibold text-ink">{plan.length + 1}. </span>
            {later}
          </div>
        </li>
      </ol>

      {bond > 0n && (
        <p className="text-sm text-muted">
          Each proposal needs the DAO’s {nearAmount(policy.proposal_bond)} bond, returned after the
          vote.
        </p>
      )}
      {blocked.length > 0 && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {accountId} can’t file{" "}
          {blocked.length === plan.length ? "these proposals" : `“${blocked[0]?.title}”`} in this
          DAO. Connect an account with the right role, or send this page to someone who has it.
        </p>
      )}

      {/* Once everything is filed, the voting card below is the only next step. */}
      {!allDone && (
        <div className="flex flex-wrap gap-3">
          {!accountId ? (
            <Button onClick={connect}>Connect wallet</Button>
          ) : (
            <Button onClick={submit} disabled={busy || allDone || blocked.length > 0}>
              {busy
                ? "Waiting for wallet…"
                : Object.values(states).some((s) => s.status === "error")
                  ? "Try again"
                  : `Submit ${plan.length === 1 ? "proposal" : `${plan.length} proposals`}`}
            </Button>
          )}
          {/* Once something is filed, going back could file it twice. */}
          {!Object.values(states).some((s) => s.status === "done") && (
            <Button variant="secondary" onClick={onBack} disabled={busy}>
              Back
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
