"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CONTRACT, EXPECTED_CODE_HASH, proposalUrl } from "@/lib/config";
import {
  canApprove,
  canPropose,
  type DaoPolicy,
  getPolicy,
  type ProposalStatus,
  upgradeKind,
} from "@/lib/dao";
import { type DaoProposal, view, viewAccount } from "@/lib/near";
import { Button, Card, ExternalLink, Pill, Skeleton } from "./ui";
import { useWallet } from "./wallet";

/** Sputnik passes the vote's leftover gas to `upgrade`, which deploys the code and runs `migrate`. */
const VOTE_TGAS = 300;

type Loaded = {
  dao: string;
  running: string;
  stored: boolean;
  policy: DaoPolicy;
  proposal: { id: number; status: ProposalStatus; kind: object } | null;
};

/** The newest DAO proposal that installs this code on the contract. */
async function findUpgrade(dao: string, hash: string, scan = 50) {
  const last = await view<number>(dao, "get_last_proposal_id");
  const from = Math.max(0, last - scan);
  const page = await view<DaoProposal[]>(dao, "get_proposals", { from_index: from, limit: scan });
  const match = page.filter((p) => {
    const u = (p.kind as { UpgradeRemote?: { receiver_id: string; hash: string } }).UpgradeRemote;
    return u?.receiver_id === CONTRACT && u.hash === hash;
  });
  const p = match.sort((a, b) => b.id - a.id)[0];
  return p ? { id: p.id, status: p.status as ProposalStatus, kind: p.kind } : null;
}

/**
 * Installs the code this app was built for, by DAO vote: someone stores the code in the DAO,
 * an Admin files `UpgradeRemote`, the council approves it. Each step is one button.
 */
export function CodeUpdate() {
  const { accountId, connect, call } = useWallet();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Set when this page's own approval installed the code, for the success line.
  const [updated, setUpdated] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ value: account }, config] = await Promise.all([
        viewAccount(CONTRACT),
        view<{ dao_id: string }>(CONTRACT, "get_config"),
      ]);
      const dao = config.dao_id;
      const [policy, stored, proposal] = await Promise.all([
        getPolicy(dao),
        view<boolean>(dao, "has_blob", { hash: EXPECTED_CODE_HASH }).catch(() => false),
        findUpgrade(dao, EXPECTED_CODE_HASH),
      ]);
      setError(null);
      setData({ dao, running: account.code_hash, stored, policy, proposal });
    } catch {
      setError("Couldn’t read the contract or its DAO.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  const hash = EXPECTED_CODE_HASH;
  const { dao, running, stored, policy, proposal } = data;
  const done = running === hash;
  const open = proposal?.status === "InProgress";
  const mayFile = accountId ? canPropose(policy, accountId, "upgrade_remote") : null;
  const mayVote = accountId ? canApprove(policy, accountId, "upgrade_remote") : null;

  async function send(step: "file" | "approve") {
    setBusy(true);
    setSendError(null);
    const r =
      step === "file"
        ? await call(
            "add_proposal",
            {
              proposal: {
                description: `* Title: Install new Earmark code on ${CONTRACT} <br>* Notes: Replaces the contract's code with build ${hash}. Budgets, payments and records stay as they are. Check the build on Earmark's Verify page before voting.`,
                kind: upgradeKind(CONTRACT, hash),
              },
            },
            { receiverId: dao, gasTgas: 50, deposit: policy.proposal_bond },
          )
        : await call(
            "act_proposal",
            { id: proposal?.id, action: "VoteApprove", proposal: proposal?.kind },
            { receiverId: dao, gasTgas: VOTE_TGAS },
          );
    setBusy(false);
    if (!r.ok) setSendError(r.error);
    else if (step === "approve") setUpdated(true);
    await load();
  }

  const pill = done
    ? { tone: "green" as const, text: "Up to date" }
    : open
      ? { tone: "amber" as const, text: "Council voting" }
      : stored
        ? { tone: "blue" as const, text: "Update ready" }
        : { tone: "gray" as const, text: "Code not stored" };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Earmark contract</p>
          <p className="text-sm text-muted">
            {done ? "Latest version" : "A newer version is ready"} ·{" "}
            <Link href="/verify" className="font-medium text-brand hover:underline">
              Details
            </Link>
          </p>
        </div>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </div>

      {done && (
        <p className={updated ? "font-medium text-emerald-700" : "text-muted"}>
          {updated
            ? "Updated. Budgets and payments kept."
            : "Nothing to do. Only a DAO vote can change this code."}
        </p>
      )}

      {!done && !proposal && !stored && (
        <p className="text-muted">
          The new code isn’t stored in your DAO yet. Once it is, you can ask your council to install
          it here.
        </p>
      )}

      {!done && (!proposal || !open) && stored && (
        <div className="space-y-3">
          {proposal && proposal.status !== "Approved" && (
            <p className="text-sm text-amber-800">
              The last update vote{" "}
              <ExternalLink href={proposalUrl(dao, proposal.id)}>#{proposal.id}</ExternalLink> is{" "}
              {proposal.status.toLowerCase()}.
            </p>
          )}
          {proposal?.status === "Approved" && (
            <p className="text-sm text-amber-800">
              Vote <ExternalLink href={proposalUrl(dao, proposal.id)}>#{proposal.id}</ExternalLink>{" "}
              passed but the code didn’t change. The old code still runs and nothing was lost.
            </p>
          )}
          <p className="text-muted">
            Your council votes to install the new code. Budgets, payments and records stay as they
            are.
          </p>
          {mayFile === false && (
            <p className="text-sm text-amber-800">
              {accountId} can’t file code updates in this DAO.
            </p>
          )}
          {!accountId ? (
            <Button onClick={connect}>Connect wallet</Button>
          ) : (
            <Button onClick={() => send("file")} disabled={busy || mayFile === false}>
              {busy ? "Waiting for wallet…" : "Start the update vote"}
            </Button>
          )}
        </div>
      )}

      {!done && open && proposal && (
        <div className="space-y-3">
          <p className="text-muted">
            Update vote{" "}
            <ExternalLink href={proposalUrl(dao, proposal.id)}>#{proposal.id}</ExternalLink> is
            open. The new code installs when it passes.
          </p>
          {mayVote === false && (
            <p className="text-sm text-amber-800">{accountId} can’t vote on code updates.</p>
          )}
          {!accountId ? (
            <Button onClick={connect}>Connect wallet</Button>
          ) : (
            <Button onClick={() => send("approve")} disabled={busy || mayVote === false}>
              {busy ? "Waiting for wallet…" : "Approve"}
            </Button>
          )}
        </div>
      )}

      {sendError && <p className="text-sm text-rose-700">{sendError}</p>}
    </Card>
  );
}
