"use client";

import { useCallback, useEffect, useState } from "react";
import { CONTRACT, proposalUrl } from "@/lib/config";
import {
  canPropose,
  type EnvelopeInput,
  fromBase64,
  fundKind,
  getPolicy,
  type ProposalStatus,
} from "@/lib/dao";
import { money, toBase, units } from "@/lib/format";
import { findFunding, getProposal, getToken, listBudgets } from "@/lib/near";
import type { Budget, TokenMeta } from "@/lib/types";
import { input } from "./setup-form";
import { Button, ButtonLink, Card, ExternalLink, Pill, Skeleton } from "./ui";
import { useWallet } from "./wallet";

/** How often an open vote is re-read while the page is visible. */
const POLL_MS = 10_000;

type Loaded = {
  status: ProposalStatus;
  envelope: EnvelopeInput;
  meta: TokenMeta;
  budget: Budget | null;
  /** The newest funding vote for this budget, if any. */
  funding: { id: number; status: ProposalStatus } | null;
  bond: string;
  canFund: boolean | null;
};

/** The budget's own proposal: read its args back, wait for the vote, then file the funding. */
export function SetupFund({
  dao,
  proposalId,
  amount: initialAmount,
}: {
  dao: string;
  proposalId: number;
  amount: string | null;
}) {
  const { accountId, connect, call } = useWallet();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, policy] = await Promise.all([getProposal(dao, proposalId), getPolicy(dao)]);
      const fc = (
        p.kind as {
          FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string }[] };
        }
      ).FunctionCall;
      const action = fc?.actions[0];
      if (fc?.receiver_id !== CONTRACT || action?.method_name !== "create_envelope") {
        setData(null);
        setError(`Proposal #${proposalId} doesn’t create an Earmark budget.`);
        return;
      }
      const { envelope } = JSON.parse(fromBase64(action.args)) as { envelope: EnvelopeInput };
      const meta = await getToken(envelope.token_id);
      // The newest open budget with this name and token is the one this proposal created.
      const budget =
        p.status === "Approved"
          ? ((await listBudgets())
              .filter((b) => b.name === envelope.name && b.token_id === envelope.token_id)
              .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null)
          : null;
      const f = budget ? await findFunding(dao, budget.id).catch(() => null) : null;
      setError(null);
      setData({
        status: p.status as ProposalStatus,
        envelope,
        meta,
        budget,
        funding: f ? { id: f.id, status: f.status as ProposalStatus } : null,
        bond: policy.proposal_bond,
        canFund: accountId ? canPropose(policy, accountId, "transfer") : null,
      });
      setAmount((a) => a || (initialAmount ? units(initialAmount, meta).replaceAll(",", "") : ""));
    } catch {
      setError(`Couldn’t read proposal #${proposalId} in ${dao}.`);
    }
  }, [dao, proposalId, accountId, initialAmount]);

  useEffect(() => {
    load();
  }, [load]);

  const funded = !!data?.budget && (data.funding?.status === "Approved" || hasMoney(data.budget));
  const waiting =
    !!data &&
    (data.status === "InProgress" ||
      (data.status === "Approved" && !data.budget) ||
      (!funded && data.funding?.status === "InProgress"));

  // Re-read while a vote is open, only while the tab is visible.
  useEffect(() => {
    if (!waiting) return;
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [waiting, load]);

  // A failed read keeps what was shown; with nothing shown yet, offer a retry.
  if (error && !data)
    return (
      <Card className="space-y-3 p-5">
        <p className="text-rose-700">{error}</p>
        <Button variant="secondary" onClick={load}>
          Try again
        </Button>
      </Card>
    );
  if (!data) return <Skeleton className="h-40" />;

  const { status, envelope, meta, budget, funding } = data;
  const base = toBase(amount, meta);
  const fundingOpen = !funded && funding?.status === "InProgress";

  async function fund() {
    if (!budget || !base) return;
    setBusy(true);
    setSendError(null);
    const proposal = {
      description: `* Title: Fund Earmark budget "${budget.name}" <br>* Notes: ${units(base, meta)} ${meta.symbol}`,
      kind: fundKind(budget.token_id, CONTRACT, base, budget.id),
    };
    const r = await call(
      "add_proposal",
      { proposal },
      { receiverId: dao, gasTgas: 50, deposit: data?.bond ?? "0" },
    );
    setBusy(false);
    if (r.ok) {
      setData((d) => d && { ...d, funding: { id: Number(r.value), status: "InProgress" } });
    } else setSendError(r.error);
  }

  const pill =
    status === "InProgress"
      ? { tone: "amber" as const, text: "Council voting" }
      : status !== "Approved"
        ? { tone: "red" as const, text: status }
        : funded
          ? { tone: "green" as const, text: "Funded" }
          : fundingOpen
            ? { tone: "amber" as const, text: "Funding vote" }
            : { tone: "green" as const, text: "Approved" };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">“{envelope.name}”</p>
          <p className="text-sm text-muted">
            Budget proposal{" "}
            <ExternalLink href={proposalUrl(dao, proposalId)}>#{proposalId}</ExternalLink>
          </p>
        </div>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </div>

      {status === "InProgress" && (
        <p className="text-muted">
          Waiting for your council to approve it. You can close this page and come back; it updates
          on its own.
        </p>
      )}

      {status !== "InProgress" && status !== "Approved" && (
        <p className="text-muted">This proposal didn’t pass, so the budget wasn’t created.</p>
      )}

      {status === "Approved" && !budget && (
        <p className="text-muted">Approved. The budget appears in a moment.</p>
      )}

      {budget && funded && (
        <div className="space-y-3">
          <p className="text-muted">The budget is live with {money(budget.available, meta)}.</p>
          <ButtonLink href={`/budgets/${budget.id}`}>Open budget</ButtonLink>
        </div>
      )}

      {budget && fundingOpen && funding && (
        <div className="space-y-3">
          <p className="text-muted">
            Funding vote{" "}
            <ExternalLink href={proposalUrl(dao, funding.id)}>#{funding.id}</ExternalLink> is open.
            The money arrives when your council approves it.
          </p>
          <ButtonLink href={`/budgets/${budget.id}`} variant="secondary">
            Open budget
          </ButtonLink>
        </div>
      )}

      {budget && !funded && !fundingOpen && (
        <div className="space-y-3">
          <p className="text-muted">The budget is live. Ask your council to fund it:</p>
          <div className="flex items-center gap-2">
            <input
              className={`${input} tabular sm:w-40`}
              inputMode="decimal"
              aria-label="Amount to fund"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="font-medium text-muted">{meta.symbol}</span>
          </div>
          {sendError && <p className="text-sm text-rose-700">{sendError}</p>}
          {data.canFund === false && (
            <p className="text-sm text-amber-800">
              {accountId} can’t ask this DAO for payments. Someone in its Requestor role can.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {!accountId ? (
              <Button onClick={connect}>Connect wallet</Button>
            ) : (
              <Button onClick={fund} disabled={busy || !base || data.canFund === false}>
                {busy ? "Waiting for wallet…" : "File funding proposal"}
              </Button>
            )}
            <ButtonLink href={`/budgets/${budget.id}`} variant="secondary">
              Open budget
            </ButtonLink>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Money has reached the budget (some may already be paid out). */
function hasMoney(b: Budget): boolean {
  return BigInt(b.balance) > 0n || BigInt(b.spent_total) > 0n;
}
