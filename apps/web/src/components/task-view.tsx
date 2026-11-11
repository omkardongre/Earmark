"use client";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { CONTRACT } from "@/lib/config";
import { BLOCKED, money, shortName, TASK_STATUS, TASK_SYSTEM_REASON } from "@/lib/format";
import { view } from "@/lib/near";
import type { BlockReason, SpendRequest, Task, Tier, TokenMeta, TrustView } from "@/lib/types";
import { LocalTime } from "./local-time";
import { type Team, useRole } from "./roles";
import { input } from "./setup-form";
import { useToast } from "./toast";
import { Button, ButtonLink, Card, ExternalLink, Person, Pill, Spinner, TextButton } from "./ui";
import { useWallet } from "./wallet";

type Check = { tier: Tier | null; blocked: BlockReason | null };

const ACCEPT: Record<Tier, { label: string; hint: (who: string) => string }> = {
  auto: { label: "Pays now", hint: () => "Within your own limit." },
  trusted: {
    label: "Pays now",
    hint: (who) => `${who} is trusted here, so no approval is needed.`,
  },
  one_approver: { label: "Needs one approval", hint: () => "An approver gets it in their inbox." },
  escalate: { label: "Goes to a DAO vote", hint: () => "Above the one-approval limit." },
};

const DUPLICATE = "You were already paid for this link. Send a new one.";
const isLink = (s: string) => /^https?:\/\//i.test(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One task, for whoever is signed in: what it pays, the one next step, and the facts. It keeps
 * its own copy of the task and reloads it after each action, so the next step shows at once
 * (no page reload needed).
 */
export function TaskView({
  taskId,
  initial,
  initialTrust,
  initialPaidNs,
  team,
  meta,
}: {
  taskId: string;
  initial: Task;
  initialTrust: TrustView | null;
  /** When the task's payment went out, if it's paid. */
  initialPaidNs: string | null;
  team: Team;
  meta: TokenMeta;
}) {
  const toast = useToast();
  const [task, setTask] = useState(initial);
  const [trust, setTrust] = useState(initialTrust);
  const [paidNs, setPaidNs] = useState(initialPaidNs);
  // Fresh server data (a router refresh) replaces ours when it differs.
  const seen = useRef(initial);
  useEffect(() => {
    if (same(seen.current, initial)) return;
    seen.current = initial;
    setTask(initial);
    setTrust(initialTrust);
    setPaidNs(initialPaidNs);
  }, [initial, initialTrust, initialPaidNs]);

  /** Reads the task until it differs from `before` (the node can lag a few seconds). */
  const reload = useCallback(
    async (before: Task): Promise<Task | null> => {
      for (const ms of [600, 1200, 2000, 3000, 5000]) {
        await sleep(ms);
        try {
          const t = await view<Task | null>(CONTRACT, "get_task", { task_id: taskId });
          if (!t || same(t, before)) continue;
          setTask(t);
          if (t.claimant)
            view<TrustView>(CONTRACT, "get_contributor_trust", {
              envelope_id: t.envelope_id,
              account_id: t.claimant,
            })
              .then(setTrust)
              .catch(() => {});
          // Paid just now: an instant payment went out when it was made, a later one about now.
          if (t.status === "paid" && t.request_id)
            view<SpendRequest | null>(CONTRACT, "get_request", { request_id: t.request_id })
              .then((r) =>
                setPaidNs(
                  (p) =>
                    p ??
                    (r && (r.tier === "auto" || r.tier === "trusted")
                      ? r.created_at_ns
                      : String(BigInt(Date.now()) * 1_000_000n)),
                ),
              )
              .catch(() => {});
          return t;
        } catch {
          // Try again on the next round.
        }
      }
      return null;
    },
    [taskId],
  );

  const s = TASK_STATUS[task.status];
  const who = task.claimant ? shortName(task.claimant) : "";
  const reason = task.reason;
  const ownWords = !!reason && !(reason in TASK_SYSTEM_REASON);
  const sentBack = task.status === "claimed" && ownWords;
  const { me, role } = useRole(team);
  const reviewer = !!me && (me === task.lead || role === "approver");
  const isClaimant = !!me && me === task.claimant;
  const showWork = !!task.work_ref && ["submitted", "accepted", "paid"].includes(task.status);
  return (
    <>
      <Card className="space-y-6 p-6">
        <div className="flex items-center justify-between gap-3">
          <p className="tabular text-4xl font-bold tracking-tight">{money(task.amount, meta)}</p>
          <Pill tone={s.tone}>{s.label}</Pill>
        </div>
        {sentBack && isClaimant && (
          <div className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900">
            <p className="font-semibold">Sent back to you to fix</p>
            <p className="whitespace-pre-line break-words">{reason}</p>
          </div>
        )}
        <Actions
          taskId={taskId}
          task={task}
          team={team}
          meta={meta}
          reload={reload}
          onDone={(text, href) => toast({ ok: true, text, ...(href ? { href } : {}) })}
        />
      </Card>
      {showWork && task.work_ref && (
        <Card className="space-y-2 p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">{who ? `${who}’s work` : "The work"}</h2>
            {isLink(task.work_ref) ? (
              <ExternalLink href={task.work_ref}>Open the work</ExternalLink>
            ) : null}
          </div>
          {!isLink(task.work_ref) && <p className="break-all">{task.work_ref}</p>}
          {task.note && <p className="whitespace-pre-line break-words text-muted">{task.note}</p>}
        </Card>
      )}
      <Card className="p-6">
        <dl className="space-y-3">
          {task.status === "paid" && paidNs && (
            <Row label="Paid">
              <LocalTime ns={paidNs} />
            </Row>
          )}
          <Row label="Posted by">
            <Person id={task.lead} />
          </Row>
          {task.brief && (
            <Row label="Brief">
              {isLink(task.brief) ? (
                <ExternalLink href={task.brief}>Open the brief</ExternalLink>
              ) : (
                <span className="break-words">{task.brief}</span>
              )}
            </Row>
          )}
          {task.assignee && (
            <Row label="Only for">
              <Person id={task.assignee} />
            </Row>
          )}
          {task.claimant && (
            <Row label={["paid", "accepted"].includes(task.status) ? "Done by" : "Working on it"}>
              <span className="flex items-center gap-2">
                <Person id={task.claimant} />
                {trust?.trusted && <Pill tone="green">Trusted</Pill>}
              </span>
            </Row>
          )}
          {task.status === "claimed" && task.claim_ends_ns && (
            <Row label="Due">
              <LocalTime ns={task.claim_ends_ns} />
            </Row>
          )}
          {sentBack && !isClaimant && reviewer && (
            <Row label="Sent back">
              <span className="break-words">{reason}</span>
            </Row>
          )}
          {reason &&
            !sentBack &&
            task.status !== "paid" &&
            reason !== "Cancelled" &&
            (ownWords ? reviewer : true) && (
              <Row
                label={
                  task.status === "cancelled"
                    ? "Cancelled"
                    : ownWords
                      ? "Last work rejected"
                      : "Last update"
                }
              >
                <span className="break-words">{TASK_SYSTEM_REASON[reason] ?? reason}</span>
              </Row>
            )}
          {task.status !== "paid" && (
            <Row label="Posted">
              <LocalTime ns={task.created_at_ns} />
            </Row>
          )}
        </dl>
      </Card>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** The one main step for the signed-in person, with quieter choices under it. */
function Actions({
  taskId,
  task,
  team,
  meta,
  reload,
  onDone,
}: {
  taskId: string;
  task: Task;
  team: Team;
  meta: TokenMeta;
  reload: (before: Task) => Promise<Task | null>;
  onDone: (text: string, href?: string) => void;
}) {
  const { connect, call } = useWallet();
  const { me, role } = useRole(team);
  const [busy, setBusy] = useState<string | null>(null);
  /** Shown while the new state loads after an action went through. */
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [work, setWork] = useState("");
  const [note, setNote] = useState("");
  const [workProblem, setWorkProblem] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [panel, setPanel] = useState<"none" | "back" | "reject">("none");
  const [check, setCheck] = useState<Check | null>(null);

  const isLead = !!me && me === task.lead;
  const isApprover = role === "approver";
  const reviewer = isLead || isApprover;
  const isClaimant = !!me && me === task.claimant;
  const canClaim = role === "contributor" && (!task.assignee || task.assignee === me);
  const pastDeadline =
    task.claim_ends_ns !== null && BigInt(task.claim_ends_ns) / 1_000_000n < BigInt(Date.now());
  const who = task.claimant ? shortName(task.claimant) : "";
  const lead = shortName(task.lead);

  // The lead sees which way accepting pays before signing, from the contract's own check.
  useEffect(() => {
    if (!isLead || task.status !== "submitted") return;
    view<Check>(CONTRACT, "check_accept", { task_id: taskId })
      .then(setCheck)
      .catch(() => setCheck(null));
  }, [isLead, task.status, taskId]);

  // A new state starts clean: no old panel, text or message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the status changes.
  useEffect(() => {
    setPanel("none");
    setReason("");
    setError(null);
    setNotice(null);
  }, [task.status]);

  /** Whether this link was already paid to me in this budget (the contract's own check). */
  const alreadyPaid = useCallback(
    async (ref: string): Promise<boolean> => {
      if (!me) return false;
      try {
        const r = await view<Check>(CONTRACT, "check_spend", {
          envelope_id: task.envelope_id,
          spender: task.lead,
          request_id: `check-${taskId}`,
          payee: me,
          amount: task.amount,
          work_ref: ref,
        });
        return r.blocked === "duplicate_work";
      } catch {
        return false;
      }
    },
    [me, task.envelope_id, task.lead, task.amount, taskId],
  );

  // Check the link as it's typed, so a paid link is caught before the wallet opens.
  useEffect(() => {
    const ref = work.trim();
    setWorkProblem(null);
    if (task.status !== "claimed" || !isClaimant || !ref) return;
    let live = true;
    const t = setTimeout(async () => {
      if (live && (await alreadyPaid(ref)) && live) setWorkProblem(DUPLICATE);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [work, task.status, isClaimant, alreadyPaid]);

  const run = async (
    key: string,
    method: string,
    args: object,
    ok: string,
    { gasTgas = 30, href }: { gasTgas?: number; href?: string } = {},
  ) => {
    setBusy(key);
    setError(null);
    const before = task;
    const r = await call(method, { task_id: taskId, ...args }, { gasTgas });
    if (r.ok) {
      setBusy(null);
      setNotice("Done. Loading the next step…");
      onDone(ok, href);
      let fresh = await reload(before);
      // An instant payment settles a moment after "accepted": wait for "paid".
      if (fresh?.status === "accepted") fresh = (await reload(fresh)) ?? fresh;
      if (!fresh) setNotice(`${ok} Reload the page to see the next step.`);
      return;
    }
    // A wallet can close without saying how it went: if the task changed, it went through.
    const fresh = await reload(before).catch(() => null);
    setBusy(null);
    if (fresh) {
      onDone(ok, href);
      return;
    }
    if (method === "submit_work" && (await alreadyPaid(work.trim()))) setError(DUPLICATE);
    else setError(r.error);
  };

  if (notice)
    return (
      <p
        className="flex items-center justify-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 font-medium text-emerald-800"
        role="status"
      >
        {notice.endsWith("…") && <Spinner />}
        {notice}
      </p>
    );

  const errorLine = error && (
    <p className="rounded-xl bg-rose-50 px-4 py-3 text-rose-700" role="alert">
      {error}
    </p>
  );
  const line = (text: ReactNode, sub?: ReactNode) => (
    <div className="space-y-0.5 text-center">
      <p className="font-medium">{text}</p>
      {sub && <p className="text-sm text-muted">{sub}</p>}
    </div>
  );
  const days = `${task.claim_days} ${task.claim_days === 1 ? "day" : "days"}`;
  const cancel = (
    <TextButton
      busy={busy === "cancel"}
      disabled={!!busy && busy !== "cancel"}
      onClick={() => void run("cancel", "cancel_task", { reason: "Cancelled" }, "Task cancelled.")}
    >
      {busy === "cancel" ? "Confirm in your wallet…" : "Cancel task"}
    </TextButton>
  );
  const quiet = (...items: ReactNode[]) => (
    <div className="flex flex-wrap justify-center gap-1">{items}</div>
  );

  const paidLine = `Paid. ${isClaimant ? "You" : who} got ${money(task.amount, meta)}.`;
  if (task.status === "paid")
    return task.request_id ? (
      <div className="space-y-3">
        {line(paidLine)}
        <ButtonLink href={`/payments/${task.request_id}`} className="w-full">
          See the receipt
        </ButtonLink>
      </div>
    ) : (
      line(paidLine)
    );
  if (task.status === "accepted")
    return (
      <div className="space-y-3">
        {line("Accepted. The payment is on its way.")}
        {task.request_id && (
          <ButtonLink href={`/payments/${task.request_id}`} variant="secondary" className="w-full">
            See the payment
          </ButtonLink>
        )}
      </div>
    );
  if (task.status === "cancelled") return line("This task was cancelled. Its money went back.");

  if (!me)
    return (
      <div className="space-y-2 text-center">
        <Button className="w-full" onClick={() => void connect()}>
          Sign in
        </Button>
        <p className="text-sm text-muted">To take this task, or to review it.</p>
      </div>
    );

  if (task.status === "open") {
    if (canClaim)
      return (
        <div className="space-y-3">
          {errorLine}
          <Button
            className="w-full"
            busy={busy === "claim"}
            onClick={() =>
              void run("claim", "claim_task", {}, "It’s yours. Send the work when it’s done.")
            }
          >
            {busy === "claim" ? "Confirm in your wallet…" : "Take this task"}
          </Button>
          <p className="text-center text-sm text-muted">
            You get {days} to finish. The money is already set aside.
          </p>
        </div>
      );
    if (reviewer)
      return (
        <div className="space-y-3">
          {errorLine}
          {line("Waiting for someone to take it", `They get ${days} to finish once they take it.`)}
          {quiet(<span key="c">{cancel}</span>)}
        </div>
      );
    return line(
      task.assignee && task.assignee !== me
        ? `This task is for ${shortName(task.assignee)}.`
        : "Only people on this budget can take its tasks.",
      task.assignee && task.assignee !== me ? undefined : "Ask an approver to add you.",
    );
  }

  if (task.status === "claimed") {
    if (isClaimant) {
      const ref = work.trim();
      const submit = async () => {
        if (!ref || busy || workProblem) return;
        if (await alreadyPaid(ref)) return setWorkProblem(DUPLICATE);
        void run(
          "submit",
          "submit_work",
          { work_ref: ref, note: note.trim() || null },
          `Sent. ${lead} reviews it next.`,
        );
      };
      return (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {errorLine}
          <label className="block space-y-1.5">
            <span className="font-medium">Link to your work</span>
            <input
              className={input}
              placeholder="https://"
              value={work}
              onChange={(e) => setWork(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={256}
              aria-invalid={!!workProblem}
              aria-describedby={workProblem ? "work-problem" : undefined}
            />
            {workProblem && (
              <span id="work-problem" className="block text-sm text-rose-700" role="alert">
                {workProblem}
              </span>
            )}
          </label>
          <label className="block space-y-1.5">
            <span className="font-medium">Note</span>
            <input
              className={input}
              placeholder={`For ${lead} (optional)`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={256}
            />
          </label>
          <Button
            type="submit"
            className="w-full"
            busy={busy === "submit"}
            disabled={(!!busy && busy !== "submit") || !ref || !!workProblem}
          >
            {busy === "submit" ? "Confirm in your wallet…" : "Send the work"}
          </Button>
          {quiet(
            <TextButton
              key="g"
              busy={busy === "release"}
              disabled={!!busy && busy !== "release"}
              onClick={() =>
                void run("release", "release_claim", {}, "You gave it up. It’s open again.")
              }
            >
              {busy === "release" ? "Confirm in your wallet…" : "Give it up"}
            </TextButton>,
          )}
        </form>
      );
    }
    const due = task.claim_ends_ns ? <LocalTime ns={task.claim_ends_ns} /> : null;
    return (
      <div className="space-y-3">
        {errorLine}
        {line(
          `${who} is working on it`,
          due ? (
            <>
              {pastDeadline ? "Was due" : "Due"} {due}
            </>
          ) : undefined,
        )}
        {(reviewer || pastDeadline) &&
          quiet(
            <TextButton
              key="o"
              busy={busy === "release"}
              disabled={!!busy && busy !== "release"}
              onClick={() => void run("release", "release_claim", {}, "It’s open again.")}
            >
              {busy === "release" ? "Confirm in your wallet…" : "Open it to others"}
            </TextButton>,
            reviewer ? <span key="c">{cancel}</span> : null,
          )}
      </div>
    );
  }

  // Work sent: the lead accepts; the lead or an approver can send it back or reject it.
  if (!reviewer)
    return line(isClaimant ? `Sent. ${lead} reviews it next.` : "Work sent. Waiting for the lead.");

  if (panel === "back" || panel === "reject") {
    const text = reason.trim();
    const reasonField = (
      <label className="block space-y-1.5">
        <span className="font-medium">
          {panel === "back" ? `What should ${who} fix?` : "Why isn’t it acceptable?"}
        </span>
        <textarea
          className={`${input} min-h-20 py-2.5`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={256}
          placeholder={panel === "back" ? "The title is wrong" : "Copied from another site"}
          // biome-ignore lint/a11y/noAutofocus: the panel opens for this one field.
          autoFocus
        />
      </label>
    );
    if (panel === "reject")
      return (
        <div className="space-y-4">
          {errorLine}
          <div className="rounded-xl bg-rose-50 px-4 py-3 text-rose-800">
            <p className="font-semibold">Reject as not acceptable?</p>
            <p>
              This removes {who}’s trust in this budget, and the task opens to others. Use it for
              spam, copied or undone work.
            </p>
          </div>
          {reasonField}
          <Button
            variant="danger"
            className="w-full"
            busy={busy === "cause"}
            disabled={(!!busy && busy !== "cause") || !text}
            onClick={() =>
              void run(
                "cause",
                "reject_work",
                { reason: text, for_cause: true },
                "Rejected. The task is open to others again.",
              )
            }
          >
            {busy === "cause" ? "Confirm in your wallet…" : "Reject"}
          </Button>
          {quiet(
            <TextButton key="k" disabled={!!busy} onClick={() => setPanel("back")}>
              Send it back to fix instead
            </TextButton>,
          )}
        </div>
      );
    return (
      <div className="space-y-4">
        {errorLine}
        {reasonField}
        <Button
          className="w-full"
          busy={busy === "back"}
          disabled={(!!busy && busy !== "back") || !text}
          onClick={() =>
            void run(
              "back",
              "reject_work",
              { reason: text, for_cause: false },
              `Sent back to ${who} to fix.`,
            )
          }
        >
          {busy === "back" ? "Confirm in your wallet…" : "Send back to fix"}
        </Button>
        <p className="text-center text-sm text-muted">
          {who} keeps the task and gets {days} more.
        </p>
        {quiet(
          <TextButton key="b" disabled={!!busy} onClick={() => setPanel("none")}>
            Back
          </TextButton>,
          <TextButton key="r" tone="danger" disabled={!!busy} onClick={() => setPanel("reject")}>
            Reject as not acceptable
          </TextButton>,
        )}
      </div>
    );
  }

  const tier = check?.tier ? ACCEPT[check.tier] : null;
  const accepted =
    check?.tier === "one_approver"
      ? "Accepted. An approver signs the payment next."
      : check?.tier === "escalate"
        ? "Accepted. The payment goes to a DAO vote."
        : `Paid. ${who} got ${money(task.amount, meta)}.`;
  return (
    <div className="space-y-3">
      {errorLine}
      {isLead ? (
        check?.blocked ? (
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
              busy={busy === "accept"}
              disabled={(!!busy && busy !== "accept") || !tier}
              onClick={() => void run("accept", "accept_task", {}, accepted, { gasTgas: 100 })}
            >
              {busy === "accept"
                ? "Confirm in your wallet…"
                : `Accept and pay ${money(task.amount, meta)}`}
            </Button>
          </>
        )
      ) : (
        line(`${who} sent the work`, `Waiting for ${lead} to review it.`)
      )}
      {quiet(
        <TextButton key="s" disabled={!!busy} onClick={() => setPanel("back")}>
          Send back or reject
        </TextButton>,
        isApprover ? <span key="c">{cancel}</span> : null,
      )}
    </div>
  );
}
