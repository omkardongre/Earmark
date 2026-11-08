"use client";

import { useCallback, useEffect, useState } from "react";
import { CONTRACT, proposalUrl, txUrl } from "@/lib/config";
import {
  canPropose,
  type EnvelopeInput,
  fromBase64,
  fundKind,
  getPolicy,
  type ProposalStatus,
} from "@/lib/dao";
import { money, toBase, units } from "@/lib/format";
import { getProposal, getToken, listBudgets } from "@/lib/near";
import type { Budget, TokenMeta } from "@/lib/types";
import { input } from "./setup-form";
import { Button, ButtonLink, Card, ExternalLink, Pill, Skeleton } from "./ui";
import { useWallet } from "./wallet";

type Loaded = {
  status: ProposalStatus;
  envelope: EnvelopeInput;
  meta: TokenMeta;
  budget: Budget | null;
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
  const [sent, setSent] = useState<{ id: number; hash: string } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, policy] = await Promise.all([getProposal(dao, proposalId), getPolicy(dao)]);
      const fc = (
        p.kind as {
          FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string }[] };
        }
      ).FunctionCall;
      const action = fc?.actions[0];
      if (fc?.receiver_id !== CONTRACT || action?.method_name !== "create_envelope") {
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
      setData({
        status: p.status as ProposalStatus,
        envelope,
        meta,
        budget,
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

  if (error) return <Card className="p-5 text-rose-700">{error}</Card>;
  if (!data) return <Skeleton className="h-40" />;

  const { status, envelope, meta, budget } = data;
  const base = toBase(amount, meta);

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
    if (r.ok) setSent({ id: Number(r.value), hash: r.hash });
    else setSendError(r.error);
  }

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
        <Pill tone={status === "Approved" ? "green" : status === "InProgress" ? "amber" : "red"}>
          {status === "InProgress" ? "Council voting" : status}
        </Pill>
      </div>

      {status === "InProgress" && (
        <div className="space-y-3">
          <p className="text-muted">
            Once the council approves it, come back here to fund the budget. This page’s link keeps
            your place.
          </p>
          <Button variant="secondary" onClick={load}>
            Check again
          </Button>
        </div>
      )}

      {status !== "InProgress" && status !== "Approved" && (
        <p className="text-muted">This proposal didn’t pass, so the budget wasn’t created.</p>
      )}

      {status === "Approved" && !budget && (
        <p className="text-muted">Approved, but the budget isn’t showing yet. Check again soon.</p>
      )}

      {budget && sent && (
        <div className="space-y-2">
          <p>
            Funding proposal{" "}
            <ExternalLink href={proposalUrl(dao, sent.id)}>#{sent.id}</ExternalLink> is filed. The
            money arrives when the council approves it.
          </p>
          <p className="flex gap-4 text-sm">
            <ExternalLink href={txUrl(sent.hash)}>Transaction</ExternalLink>
            <ButtonLink href={`/budgets/${budget.id}`} variant="secondary">
              Open budget
            </ButtonLink>
          </p>
        </div>
      )}

      {budget && !sent && (
        <div className="space-y-3">
          <p className="text-muted">
            The budget is live with {money(budget.balance, meta)}. Ask the DAO to fund it:
          </p>
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
              {accountId} can’t file transfer proposals in this DAO.
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
