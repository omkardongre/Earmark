"use client";

import { useCallback, useEffect, useState } from "react";
import { CONTRACT, proposalUrl } from "@/lib/config";
import {
  canApprove,
  canPropose,
  type DaoPolicy,
  factoryLockKind,
  getPolicy,
  type ProposalStatus,
} from "@/lib/dao";
import type { FactoryInfo } from "@/lib/governance";
import { type DaoProposal, view } from "@/lib/near";
import { Button, Card, ExternalLink, Pill, Skeleton } from "./ui";
import { useWallet } from "./wallet";

type Loaded = {
  dao: string;
  factory: FactoryInfo;
  policy: DaoPolicy;
  proposal: { id: number; status: ProposalStatus; kind: object } | null;
};

/** The newest proposal that turns the factory's auto-update off. */
async function findLock(dao: string, scan = 50) {
  const last = await view<number>(dao, "get_last_proposal_id");
  const page = await view<DaoProposal[]>(dao, "get_proposals", {
    from_index: Math.max(0, last - scan),
    limit: scan,
  });
  const p = page
    .filter((x) => {
      const f = (x.kind as { FactoryInfoUpdate?: { factory_info: FactoryInfo } }).FactoryInfoUpdate;
      return f?.factory_info.auto_update === false;
    })
    .sort((a, b) => b.id - a.id)[0];
  return p ? { id: p.id, status: p.status as ProposalStatus, kind: p.kind } : null;
}

/**
 * A Sputnik DAO made by the factory lets the factory install new DAO code without a vote while
 * `auto_update` is on. One FactoryInfoUpdate vote turns that off; this card files and approves it.
 */
export function DaoLock() {
  const { accountId, connect, call } = useWallet();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { dao_id: dao } = await view<{ dao_id: string }>(CONTRACT, "get_config");
      const [factory, policy, proposal] = await Promise.all([
        view<FactoryInfo>(dao, "get_factory_info"),
        getPolicy(dao),
        findLock(dao),
      ]);
      setError(null);
      setData({ dao, factory, policy, proposal });
    } catch {
      setError("Couldn’t read the DAO.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error && !data) return <Card className="p-5 text-rose-700">{error}</Card>;
  if (!data) return <Skeleton className="h-32" />;
  const { dao, factory, policy, proposal } = data;
  const locked = !factory.auto_update;
  const open = proposal?.status === "InProgress";
  const mayFile = accountId ? canPropose(policy, accountId, "factory_info_update") : null;
  const mayVote = accountId ? canApprove(policy, accountId, "factory_info_update") : null;

  async function send(step: "file" | "approve") {
    setBusy(true);
    setSendError(null);
    const r =
      step === "file"
        ? await call(
            "add_proposal",
            {
              proposal: {
                description: `* Title: Only our own vote changes the DAO's code <br>* Notes: Turns off auto-update from ${factory.factory_id}. After this, new Sputnik code installs only if this DAO votes for it.`,
                kind: factoryLockKind(factory.factory_id),
              },
            },
            { receiverId: dao, gasTgas: 50, deposit: policy.proposal_bond },
          )
        : await call(
            "act_proposal",
            { id: proposal?.id, action: "VoteApprove", proposal: proposal?.kind },
            { receiverId: dao, gasTgas: 50 },
          );
    setBusy(false);
    if (!r.ok) setSendError(r.error);
    await load();
  }

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">DAO code</p>
          <p className="text-sm text-muted">{dao}</p>
        </div>
        <Pill tone={locked ? "green" : open ? "amber" : "gray"}>
          {locked ? "Only your vote" : open ? "Council voting" : "Factory can update"}
        </Pill>
      </div>
      {locked ? (
        <p className="text-muted">Nothing to do. Only a vote of this DAO can change its code.</p>
      ) : open && proposal ? (
        <div className="space-y-3">
          <p className="text-muted">
            Vote <ExternalLink href={proposalUrl(dao, proposal.id)}>#{proposal.id}</ExternalLink> is
            open. When it passes, only this DAO’s vote can change its code.
          </p>
          {mayVote === false && (
            <p className="text-sm text-amber-800">{accountId} can’t vote on this.</p>
          )}
          {!accountId ? (
            <Button onClick={connect}>Connect wallet</Button>
          ) : (
            <Button onClick={() => send("approve")} disabled={busy || mayVote === false}>
              {busy ? "Waiting for wallet…" : "Approve"}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-muted">
            {factory.factory_id} can still install new DAO code without your vote. One vote turns
            that off.
          </p>
          {mayFile === false && (
            <p className="text-sm text-amber-800">{accountId} can’t file this vote.</p>
          )}
          {!accountId ? (
            <Button onClick={connect}>Connect wallet</Button>
          ) : (
            <Button onClick={() => send("file")} disabled={busy || mayFile === false}>
              {busy ? "Waiting for wallet…" : "Start the vote"}
            </Button>
          )}
        </div>
      )}
      {sendError && <p className="text-sm text-rose-700">{sendError}</p>}
    </Card>
  );
}
