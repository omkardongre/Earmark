"use client";

import { useEffect, useState } from "react";
import { CONTRACT } from "@/lib/config";
import { BLOCKED, money, shortName } from "@/lib/format";
import { view } from "@/lib/near";
import type { BlockReason, Task, Tier, TokenMeta } from "@/lib/types";
import { input } from "./setup-form";
import { Button, ButtonLink, Pill } from "./ui";
import { useWallet } from "./wallet";

type Check = { tier: Tier | null; blocked: BlockReason | null };

const ACCEPT: Record<Tier, { label: string; hint: (who: string) => string }> = {
  auto: { label: "Pays now", hint: () => "Within your own limit." },
  trusted: {
    label: "Pays now",
    hint: (who) => `${who} is a trusted contributor, so no approval is needed.`,
  },
  one_approver: { label: "Needs one approval", hint: () => "An approver gets it in their inbox." },
  escalate: { label: "Goes to a DAO vote", hint: () => "Above the one-approval limit." },
};

/**
 * The one thing the signed-in person can do with a task now: take it, send the work, accept and
 * pay, or (for the lead and approvers) send it back or cancel it.
 */
export function TaskActions({
  taskId,
  task,
  payees,
  spenders,
  approvers,
  meta,
}: {
  taskId: string;
  task: Task;
  payees: string[];
  spenders: string[];
  approvers: string[];
  meta: TokenMeta;
}) {
  const { accountId, connect, call } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [work, setWork] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);

  const me = accountId;
  const isLead = me === task.lead;
  const isApprover = !!me && approvers.includes(me);
  const reviewer = isLead || isApprover;
  const isClaimant = !!me && me === task.claimant;
  const canClaim =
    !!me &&
    payees.includes(me) &&
    !spenders.includes(me) &&
    !approvers.includes(me) &&
    (!task.assignee || task.assignee === me);
  const pastDeadline =
    task.claim_ends_ns !== null && BigInt(task.claim_ends_ns) / 1_000_000n < BigInt(Date.now());
  const who = task.claimant ? shortName(task.claimant) : "";

  // The lead sees which tier accepting takes before signing, from the contract's own check.
  useEffect(() => {
    if (!isLead || task.status !== "submitted") return;
    view<Check>(CONTRACT, "check_accept", { task_id: taskId })
      .then(setCheck)
      .catch(() => setCheck(null));
  }, [isLead, task.status, taskId]);

  const run = async (key: string, method: string, args: object, ok: string, gasTgas = 30) => {
    setBusy(key);
    setError(null);
    const r = await call(method, { task_id: taskId, ...args }, { gasTgas });
    setBusy(null);
    if (r.ok) setDone(ok);
    else setError(r.error);
  };

  if (done)
    return (
      <p className="rounded-xl bg-emerald-50 px-4 py-3 font-medium text-emerald-800">{done}</p>
    );

  const errorLine = error && (
    <p className="rounded-xl bg-rose-50 px-4 py-3 text-rose-700" role="alert">
      {error}
    </p>
  );
  const label = (key: string, text: string) => (busy === key ? "Confirm in your wallet…" : text);
  const cancel =
    (reviewer && task.status !== "submitted") || (isApprover && task.status === "submitted") ? (
      <Button
        variant="ghost"
        disabled={!!busy}
        onClick={() =>
          void run("cancel", "cancel_task", { reason: "Cancelled" }, "Task cancelled.")
        }
      >
        {label("cancel", "Cancel task")}
      </Button>
    ) : null;

  if (task.status === "paid" || task.status === "accepted")
    return task.request_id ? (
      <ButtonLink href={`/payments/${task.request_id}`} className="w-full">
        {task.status === "paid" ? "See the receipt" : "See the payment"}
      </ButtonLink>
    ) : null;
  if (task.status === "cancelled") return null;

  if (!me)
    return (
      <div className="space-y-2 text-center">
        <Button className="w-full" onClick={() => void connect()}>
          Sign in
        </Button>
        <p className="text-sm text-muted">To take this task, or to review it as its lead.</p>
      </div>
    );

  if (task.status === "open")
    return (
      <div className="space-y-3">
        {errorLine}
        {canClaim ? (
          <>
            <Button
              className="w-full"
              disabled={!!busy}
              onClick={() =>
                void run("claim", "claim_task", {}, "It’s yours. Send the work when it’s done.")
              }
            >
              {label("claim", "Take this task")}
            </Button>
            <p className="text-center text-sm text-muted">
              You get {task.claim_days} {task.claim_days === 1 ? "day" : "days"} to finish. The{" "}
              {money(task.amount, meta)} is already set aside.
            </p>
          </>
        ) : (
          !reviewer && (
            <p className="text-muted">
              {task.assignee && task.assignee !== me
                ? `This task is for ${shortName(task.assignee)}.`
                : "Only approved payees of this budget can take its tasks. Ask an approver to add you."}
            </p>
          )
        )}
        {cancel}
      </div>
    );

  if (task.status === "claimed")
    return (
      <div className="space-y-3">
        {errorLine}
        {isClaimant ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!work.trim()) return;
              void run(
                "submit",
                "submit_work",
                { work_ref: work.trim(), note: note.trim() || null },
                "Sent. The lead reviews it next.",
              );
            }}
          >
            <input
              className={input}
              placeholder="Link to the work (https://)"
              value={work}
              onChange={(e) => setWork(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={256}
            />
            <input
              className={input}
              placeholder="Note for the lead (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={256}
            />
            <Button type="submit" className="w-full" disabled={!!busy || !work.trim()}>
              {label("submit", "Send the work")}
            </Button>
          </form>
        ) : (
          <p className="text-muted">{who} is working on it.</p>
        )}
        {(isClaimant || reviewer || pastDeadline) && (
          <Button
            variant="ghost"
            disabled={!!busy}
            onClick={() =>
              void run(
                "release",
                "release_claim",
                {},
                isClaimant ? "You gave it up. It’s open again." : "It’s open again.",
              )
            }
          >
            {label("release", isClaimant ? "Give it up" : "Open it to others")}
          </Button>
        )}
        {!isClaimant && cancel}
      </div>
    );

  // Submitted: the lead accepts; the lead or an approver can send it back.
  const tier = check?.tier ? ACCEPT[check.tier] : null;
  return (
    <div className="space-y-3">
      {errorLine}
      {isLead &&
        !rejecting &&
        (check?.blocked ? (
          <p className="flex items-start gap-2 text-rose-700">
            <Pill tone="red">Can’t pay yet</Pill>
            <span>{BLOCKED[check.blocked]}</span>
          </p>
        ) : (
          <>
            {tier && (
              <p className="flex items-start gap-2 text-muted">
                <Pill tone={check?.tier === "one_approver" ? "amber" : "green"}>{tier.label}</Pill>
                <span>{tier.hint(who)}</span>
              </p>
            )}
            <Button
              className="w-full"
              disabled={!!busy || !tier}
              onClick={() =>
                void run(
                  "accept",
                  "accept_task",
                  {},
                  check?.tier === "one_approver"
                    ? "Accepted. An approver signs the payment next."
                    : check?.tier === "escalate"
                      ? "Accepted. The payment goes to a DAO vote."
                      : `Accepted. ${who} is being paid.`,
                  100,
                )
              }
            >
              {label("accept", `Accept and pay ${money(task.amount, meta)}`)}
            </Button>
          </>
        ))}
      {!reviewer && <p className="text-muted">Work sent. Waiting for the lead.</p>}
      {reviewer &&
        (rejecting ? (
          <div className="space-y-3 rounded-xl border border-line p-4">
            <input
              className={input}
              placeholder="What needs changing"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={256}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={!!busy || !reason.trim()}
                onClick={() =>
                  void run(
                    "back",
                    "reject_work",
                    { reason: reason.trim(), for_cause: false },
                    `Sent back to ${who} to fix.`,
                  )
                }
              >
                {label("back", "Send back to fix")}
              </Button>
              <Button
                variant="danger"
                disabled={!!busy || !reason.trim()}
                onClick={() =>
                  void run(
                    "cause",
                    "reject_work",
                    { reason: reason.trim(), for_cause: true },
                    "Rejected. The task is open to others again.",
                  )
                }
              >
                {label("cause", "Reject: not acceptable")}
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>
                Back
              </Button>
            </div>
            <p className="text-sm text-muted">
              “Not acceptable” (spam, copied, not done) counts against {who}’s record here.
            </p>
          </div>
        ) : (
          <Button variant="ghost" onClick={() => setRejecting(true)}>
            Send back or reject
          </Button>
        ))}
      {cancel}
    </div>
  );
}
