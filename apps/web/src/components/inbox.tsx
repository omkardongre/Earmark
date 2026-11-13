"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { describeChange } from "@/lib/activity";
import { CONTRACT } from "@/lib/config";
import { ago, duration, isWalletAddress, STATUS, shortName, toBase } from "@/lib/format";
import { nearComAddress } from "@/lib/intents";
import { getConfig, view } from "@/lib/near";
import { isAccountId, nearAmount } from "@/lib/token";
import type { RequestStatus } from "@/lib/types";
import { useRegistration } from "./pay-sheet";
import { useToast } from "./toast";
import { Button, ButtonLink, Card, Disclosure, Empty, Person, Pill, Section } from "./ui";
import { FeeNote, useWallet } from "./wallet";

export type InboxBudget = {
  id: string;
  name: string;
  approvers: string[];
  paused: boolean;
  pausedBy?: string;
  pausedNs?: string;
  symbol: string;
  decimals: number;
  ceiling: string;
  /** Free to spend (this payment is already set aside, so it doesn't drop again). */
  left: string;
  pending: {
    id: string;
    spender: string;
    payee: string;
    amount: string;
    work: string;
    memo: string;
    createdNs: string;
    expiresNs: string;
    /** Why this approver is asked, the payee's history here, and the task it came from. */
    why?: string;
    history?: string;
    task?: { id: string; title: string; lead: string };
  }[];
  recent: Recent[];
  changes: {
    id: string;
    kind: string;
    spender: string | null;
    text: string;
    by: string;
    effectiveNs: string;
    /** The account the change is about (a new payee), when it has one. */
    payee?: string | null;
  }[];
  /** Who can be paid from this budget now. */
  payees: string[];
  /** The payees paid into their near.com balance. */
  nearComPayees: string[];
  spenders: {
    id: string;
    paused: boolean;
    pausedBy?: string;
    pausedNs?: string;
    limit: string;
    eligible: boolean;
  }[];
};

type Change = InboxBudget["changes"][number];

type Recent = {
  id: string;
  amount: string;
  payee: string;
  status: RequestStatus;
  by: string;
  decidedNs?: string | null;
};

/**
 * What this screen knows changed before the server data shows it. The chain answers a few
 * seconds late, and a refresh can come back stale, so a confirmed action shows at once.
 * Entries expire after `KEEP_MS`, by when the refreshed server data has caught up.
 */
type Local = {
  at: number;
  decided: Map<string, Recent & { budget: string }>;
  paused: Map<string, boolean>;
  /** "budget|spender" -> when the queued unpause applies (ms). */
  unpausing: Map<string, number>;
  changesGone: Set<string>;
  /** Changes just queued here (a raise, an unpause), by change id, so Cancel shows at once. */
  changesQueued: Map<string, Change & { budget: string }>;
  /** "budget|payee" -> when a just-queued new payee becomes payable (ms). */
  payeesQueued: Map<string, number>;
  /** "budget|payee" of payees just made payable. */
  payeesAdded: Set<string>;
  /** "budget|payee" of payees just queued or made payable as near.com payees. */
  nearComAdded: Set<string>;
};
const KEEP_MS = 20_000;
const fresh = (): Local => ({
  at: 0,
  decided: new Map(),
  paused: new Map(),
  unpausing: new Map(),
  changesGone: new Set(),
  changesQueued: new Map(),
  payeesQueued: new Map(),
  payeesAdded: new Set(),
  nearComAdded: new Set(),
});

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function countdown(ms: number, now: number): string | null {
  const left = Math.ceil((ms - now) / 1000);
  if (left <= 0) return null;
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  if (d > 0) return `${d} d ${h} h`;
  return h > 0 ? `${h} h ${m} min` : `${m}:${String(s).padStart(2, "0")}`;
}
const nsToMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);

/** One fact on the approval card: a grey label, then the value. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </>
  );
}
/** Adding a payee, paid to their NEAR account or to near.com. */
const isPayeeAdd = (kind: string) => kind === "add_payee" || kind === "add_intents_payee";

export function Inbox({ budgets, delaySecs }: { budgets: InboxBudget[]; delaySecs: number }) {
  const { accountId, connect, call } = useWallet();
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<InboxBudget["pending"][number] | null>(null);
  const [local, setLocal] = useState<Local>(fresh);
  const [pauseConfirm, setPauseConfirm] = useState<{
    key: string;
    name: string;
    isBudget: boolean;
    budgetId: string;
    spenderId?: string;
  } | null>(null);
  const live = now - local.at < KEEP_MS ? local : null;
  const controlsOpen = useRef(false);
  // A Telegram alert opens /approvals#pay-<id>: once the cards show (after sign-in), go there.
  const [linked, setLinked] = useState<string | null>(null);
  useEffect(() => {
    if (!accountId || linked !== null) return;
    const hash = window.location.hash.slice(1);
    if (!hash.startsWith("pay-")) return setLinked("");
    const el = document.getElementById(hash);
    if (!el) return;
    // scroll-mt on the card leaves room for the sticky header and the section title.
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    setLinked(hash);
  });

  if (!accountId) {
    return (
      <Card className="space-y-4 p-8 text-center">
        <p className="text-lg font-semibold">Approve payments from your team</p>
        <p className="mx-auto max-w-md text-muted">
          Payments above a spender’s limit wait here for one approver. You can also pause a spender
          at once.
        </p>
        <Button onClick={connect}>Sign in</Button>
      </Card>
    );
  }

  const mine = budgets.filter((b) => b.approvers.includes(accountId));
  if (mine.length === 0) {
    return (
      <Empty action={<ButtonLink href="/">Go to budgets</ButtonLink>}>
        {shortName(accountId)} isn’t an approver on any budget. Payments are made from Budgets.
      </Empty>
    );
  }

  const later = duration(delaySecs);

  /** Runs one action. Only one at a time: the wallet shows one request at once. */
  const run = async (
    key: string,
    method: string,
    args: object,
    opts: { receiverId?: string; deposit?: string } = {},
  ) => {
    if (busy) return null;
    setBusy(key);
    const r = await call(method, args, { gasTgas: method === "approve" ? 100 : 30, ...opts });
    setBusy(null);
    if (!r.ok) toast({ ok: false, text: r.error });
    return r.ok ? r : null;
  };

  const remember = (edit: (l: Local) => void) =>
    setLocal((prev) => {
      const next: Local = {
        at: Date.now(),
        decided: new Map(prev.decided),
        paused: new Map(prev.paused),
        unpausing: new Map(prev.unpausing),
        changesGone: new Set(prev.changesGone),
        changesQueued: new Map(prev.changesQueued),
        payeesQueued: new Map(prev.payeesQueued),
        payeesAdded: new Set(prev.payeesAdded),
        nearComAdded: new Set(prev.nearComAdded),
      };
      edit(next);
      return next;
    });

  const decide = async (
    p: InboxBudget["pending"][number] & { budget: InboxBudget },
    approve: boolean,
    reject?: { reason: string; forCause: boolean },
  ) => {
    const r = approve
      ? await run(p.id, "approve", { request_id: p.id })
      : await run(p.id, "reject", {
          request_id: p.id,
          reason: reject?.reason ?? "",
          for_cause: reject?.forCause ?? false,
        });
    if (!r) return false;
    const status: RequestStatus = approve ? (r.value === "failed" ? "failed" : "paid") : "rejected";
    remember((l) =>
      l.decided.set(p.id, {
        id: p.id,
        amount: p.amount,
        payee: p.payee,
        status,
        by: accountId,
        budget: p.budget.id,
        decidedNs: String(Date.now() * 1_000_000),
      }),
    );
    toast({
      ok: true,
      text: approve
        ? status === "paid"
          ? `Approved and paid ${p.amount} to ${shortName(p.payee)}`
          : "Approved, but the payment didn’t go through. Nothing was spent."
        : `Rejected ${p.amount} to ${shortName(p.payee)}`,
      href: `/payments/${p.id}`,
      fee: !!r.sponsored,
    });
    return true;
  };

  const pending = mine
    .flatMap((b) => b.pending.map((p) => ({ ...p, budget: b })))
    .filter((p) => !live?.decided.has(p.id));
  const recent = [
    ...[...(live?.decided.values() ?? [])].filter((d) => mine.some((b) => b.id === d.budget)),
    ...mine.flatMap((b) => b.recent).filter((r) => !live?.decided.has(r.id)),
  ].slice(0, 3);
  const changesOf = (b: InboxBudget) => {
    const known = new Set(b.changes.map((c) => c.id));
    const mineNow = [...(live?.changesQueued.values() ?? [])].filter(
      (c) => c.budget === b.id && !known.has(c.id),
    );
    return [...b.changes, ...mineNow].filter((c) => !live?.changesGone.has(c.id));
  };
  /** Keeps a change this screen just queued, until the server list shows it. */
  const queued = (
    b: InboxBudget,
    value: unknown,
    change: Record<string, Record<string, string | null>>,
  ) => {
    // The contract answers the new change's id (U64, sent as a string).
    if (typeof value !== "string" && typeof value !== "number") return;
    const [kind = "", v = {}] = Object.entries(change)[0] ?? [];
    const id = String(value);
    remember((l) =>
      l.changesQueued.set(id, {
        id,
        kind,
        spender: v.spender ?? null,
        payee: null,
        text: describeChange(change, b),
        by: accountId,
        effectiveNs: String(BigInt(Date.now() + delaySecs * 1000) * 1_000_000n),
        budget: b.id,
      }),
    );
  };
  const waitingChanges = mine.reduce((n, b) => n + changesOf(b).length, 0);
  // Controls open by themselves when a change waits, and stay open once open: applying the last
  // change mustn't fold the panel away under the user.
  if (waitingChanges > 0) controlsOpen.current = true;

  const isPaused = (key: string, server: boolean) => live?.paused.get(key) ?? server;
  /** When a queued unpause applies (ms), from the chain or from this screen's own action. */
  const unpauseAt = (b: InboxBudget, spender: string | null): number | null => {
    const c = changesOf(b).find((x) => x.kind === "unpause" && x.spender === spender);
    if (c) return nsToMs(c.effectiveNs);
    return live?.unpausing.get(`${b.id}|${spender ?? ""}`) ?? null;
  };

  const label = (key: string, idle: string) => (busy === key ? "Confirm in wallet…" : idle);

  /** New payees show in the payee list; every other waiting change in "Waiting changes". */
  const payeeChanges = (b: InboxBudget) => changesOf(b).filter((c) => isPayeeAdd(c.kind));
  const otherChanges = (b: InboxBudget) => changesOf(b).filter((c) => !isPayeeAdd(c.kind));

  /** Apply (once the wait is over; the main action) and Cancel for a waiting change. */
  const changeActions = (
    b: InboxBudget,
    c: InboxBudget["changes"][number],
    ready: boolean,
    applyLabel: string,
  ) => {
    const cKey = `c${c.id}`;
    const xKey = `x${c.id}`;
    return (
      <div className="flex gap-2">
        {ready && (
          <Button
            onClick={async () => {
              const r = await run(cKey, "apply_change", { change_id: c.id });
              if (!r) return;
              remember((l) => {
                l.changesGone.add(c.id);
                if (c.kind === "unpause") l.paused.set(`${b.id}|${c.spender ?? ""}`, false);
                if (isPayeeAdd(c.kind) && c.payee) l.payeesAdded.add(`${b.id}|${c.payee}`);
                if (c.kind === "add_intents_payee" && c.payee)
                  l.nearComAdded.add(`${b.id}|${c.payee}`);
              });
              toast({ ok: true, text: appliedText(c), tx: r.hash, fee: !!r.sponsored });
            }}
          >
            {label(cKey, applyLabel)}
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={async () => {
            const r = await run(xKey, "cancel_change", { change_id: c.id });
            if (!r) return;
            remember((l) => {
              l.changesGone.add(c.id);
              l.unpausing.delete(`${b.id}|${c.spender ?? ""}`);
            });
            toast({ ok: true, text: `Cancelled: ${c.text}`, tx: r.hash, fee: !!r.sponsored });
          }}
        >
          {label(xKey, "Cancel")}
        </Button>
      </div>
    );
  };

  /** Opens the pause confirm, unless another wallet action is running. */
  const askPause = (p: NonNullable<typeof pauseConfirm>) => {
    if (!busy) setPauseConfirm(p);
  };

  /** Execute pause after confirmation. */
  const doPause = async (key: string, budgetId: string, spenderId?: string, name?: string) => {
    const r = spenderId
      ? await run(key, "pause", { envelope_id: budgetId, spender: spenderId })
      : await run(key, "pause", { envelope_id: budgetId });
    if (!r) return;
    remember((l) => {
      l.paused.set(key, true);
      l.unpausing.delete(key);
    });
    toast({
      ok: true,
      text: spenderId
        ? `${name ?? shortName(spenderId)} is paused. Their payments stop now.`
        : "Budget paused. No payments go out.",
      tx: r.hash,
      fee: !!r.sponsored,
    });
  };

  return (
    <div className="space-y-10">
      <Section title="Waiting for you">
        {pending.length === 0 ? (
          <Empty>Nothing needs you right now ✓</Empty>
        ) : (
          <div className={pending.length === 1 ? "max-w-xl" : "grid gap-4 md:grid-cols-2"}>
            {pending.map((p) => {
              const own = p.spender === accountId;
              const left = countdown(nsToMs(p.expiresNs), now);
              const soon = nsToMs(p.expiresNs) - now < 6 * 3600_000;
              const isUrl = /^https?:\/\//.test(p.work);
              return (
                <Card
                  key={p.id}
                  id={`pay-${p.id}`}
                  className={`flex scroll-mt-32 flex-col gap-5 p-5 sm:p-6 ${linked === `pay-${p.id}` ? "ring-2 ring-brand" : ""}`}
                >
                  {/* What you approve: how much, to whom, and who asked. */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted">{p.budget.name}</span>
                      <span
                        className={`tabular font-medium ${!left ? "text-rose-700" : soon ? "text-amber-700" : "text-muted"}`}
                      >
                        {left ? `${left} left` : "Expired"}
                      </span>
                    </div>
                    <p className="tabular text-3xl font-bold tracking-tight">{p.amount}</p>
                    <p className="flex flex-wrap items-center gap-1.5 text-muted">
                      to <Person id={p.payee} />
                    </p>
                    <p className="text-sm text-muted">
                      {shortName(p.spender)} asked · {ago(p.createdNs)}
                    </p>
                  </div>
                  {(p.memo || p.work) && (
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 break-words">{p.memo || (isUrl ? "" : p.work)}</p>
                      {isUrl && (
                        <a
                          href={p.work}
                          target="_blank"
                          rel="noreferrer"
                          title={p.work}
                          className="shrink-0 font-semibold text-brand hover:underline"
                        >
                          View work ↗
                        </a>
                      )}
                    </div>
                  )}
                  {/* Only the facts that change the decision. */}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-line pt-4 text-[15px]">
                    {p.why && <Row label="Why you">{p.why}</Row>}
                    <Row label="Budget left">{p.budget.left}</Row>
                    {p.history && <Row label="Paid before">{p.history}</Row>}
                    {p.task && (
                      <Row label="From task">
                        <Link
                          className="font-medium text-brand hover:underline"
                          href={`/budgets/${p.budget.id}/tasks/${p.task.id}`}
                        >
                          {p.task.title}
                        </Link>
                      </Row>
                    )}
                  </dl>
                  <div className="mt-auto flex gap-2">
                    {!left ? (
                      <Button
                        variant="secondary"
                        className="flex-1"
                        onClick={async () => {
                          const r = await run(p.id, "expire", { request_id: p.id });
                          if (!r) return;
                          remember((l) =>
                            l.decided.set(p.id, {
                              id: p.id,
                              amount: p.amount,
                              payee: p.payee,
                              status: "expired",
                              by: accountId,
                              budget: p.budget.id,
                            }),
                          );
                          toast({
                            ok: true,
                            text: "Released. The money is free again.",
                            tx: r.hash,
                            fee: !!r.sponsored,
                          });
                        }}
                      >
                        {label(p.id, "Release")}
                      </Button>
                    ) : own ? (
                      <p className="text-muted">Your own payment. Another approver decides.</p>
                    ) : (
                      <>
                        <Button className="flex-[2]" onClick={() => decide(p, true)}>
                          {label(p.id, "Approve")}
                        </Button>
                        <Button
                          variant="secondary"
                          className="flex-1"
                          onClick={() => !busy && setRejecting(p)}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                  {!own && left && <FeeNote className="-mt-2" signing={busy === p.id} />}
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      {recent.length > 0 && (
        <Section title="Recently decided">
          <Card>
            <ul className="divide-y divide-line">
              {recent.map((r) => {
                const s = STATUS[r.status];
                return (
                  <li key={r.id}>
                    <Link
                      href={`/payments/${r.id}`}
                      className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-slate-50"
                    >
                      <span className="min-w-0">
                        <span className="block">
                          {r.amount} to {shortName(r.payee)}
                        </span>
                        <span className="block text-sm text-muted">
                          by {shortName(r.by)}
                          {r.decidedNs ? ` · ${ago(r.decidedNs)}` : ""}
                        </span>
                      </span>
                      <Pill tone={s.tone}>{s.label}</Pill>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        </Section>
      )}

      <Disclosure
        title="Controls"
        open={controlsOpen.current || undefined}
        hint={
          waitingChanges > 0 ? (
            <Pill tone="amber">
              {waitingChanges} change{waitingChanges === 1 ? "" : "s"} waiting
            </Pill>
          ) : (
            "Pause, limits, payees"
          )
        }
      >
        <div className="divide-y divide-line">
          {mine.map((b) => {
            const bKey = `${b.id}|`;
            const bPaused = isPaused(bKey, b.paused);
            const bUnpause = bPaused ? unpauseAt(b, null) : null;
            const bLeft = bUnpause === null ? null : countdown(bUnpause, now);
            return (
              <div key={b.id} className="space-y-5 px-5 py-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="flex items-center gap-2 font-semibold">
                      {b.name} {bPaused && <Pill tone="amber">Paused</Pill>}
                    </p>
                    {bPaused && b.paused && b.pausedBy && b.pausedNs && (
                      <p className="text-sm text-muted">
                        Paused by {shortName(b.pausedBy)} · {ago(b.pausedNs)}
                      </p>
                    )}
                  </div>
                  {bPaused ? (
                    bUnpause !== null ? (
                      <span className="tabular text-sm text-muted">
                        {bLeft ? `Unpauses in ${bLeft}` : "Ready to unpause: apply below"}
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          const r = await run(bKey, "unpause", { envelope_id: b.id });
                          if (!r) return;
                          remember((l) => l.unpausing.set(bKey, Date.now() + delaySecs * 1000));
                          queued(b, r.value, { unpause: { spender: null } });
                          toast({
                            ok: true,
                            text: `The budget unpauses in ${later}. Any approver can cancel.`,
                            tx: r.hash,
                            fee: !!r.sponsored,
                          });
                        }}
                      >
                        {label(bKey, "Unpause budget")}
                      </Button>
                    )
                  ) : (
                    <Button
                      variant="danger"
                      onClick={() =>
                        askPause({
                          key: bKey,
                          name: b.name,
                          isBudget: true,
                          budgetId: b.id,
                        })
                      }
                    >
                      {label(bKey, "Pause budget")}
                    </Button>
                  )}
                </div>

                {otherChanges(b).length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted">Waiting changes</p>
                    {otherChanges(b).map((c) => {
                      const left = countdown(nsToMs(c.effectiveNs), now);
                      return (
                        <div
                          key={c.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3"
                        >
                          <div>
                            <p className="font-medium">{c.text}</p>
                            <p className="text-sm text-muted">
                              by {shortName(c.by)} ·{" "}
                              {left ? (
                                <span className="tabular">applies in {left}</span>
                              ) : (
                                "ready to apply"
                              )}
                            </p>
                          </div>
                          {changeActions(b, c, !left, "Apply")}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted">Spenders</p>
                  {b.spenders.map((s) => {
                    const sKey = `${b.id}|${s.id}`;
                    const paused = isPaused(sKey, s.paused);
                    const unpause = paused ? unpauseAt(b, s.id) : null;
                    const uLeft = unpause === null ? null : countdown(unpause, now);
                    const name = shortName(s.id);
                    return (
                      <div
                        key={s.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-1"
                      >
                        <span className="space-y-0.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <Person id={s.id} />
                            <span className="text-sm text-muted">up to {s.limit}</span>
                            {paused && <Pill tone="amber">Paused</Pill>}
                          </span>
                          {paused && s.paused && s.pausedBy && s.pausedNs && (
                            <span className="block text-sm text-muted">
                              Paused by {shortName(s.pausedBy)} · {ago(s.pausedNs)}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-2">
                          {s.id !== accountId && s.eligible && !paused && (
                            <RaiseButton
                              name={name}
                              limit={s.limit}
                              ceiling={b.ceiling}
                              delay={later}
                              symbol={b.symbol}
                              decimals={b.decimals}
                              busy={busy === `r${sKey}`}
                              onRaise={async (amount) => {
                                const r = await run(`r${sKey}`, "raise_limit", {
                                  envelope_id: b.id,
                                  spender: s.id,
                                  new_limit: amount,
                                });
                                if (!r) return false;
                                queued(b, r.value, {
                                  spender_auto_limit: { spender: s.id, amount },
                                });
                                toast({
                                  ok: true,
                                  text: `${name}’s new limit applies in ${later}. Any approver can cancel.`,
                                  tx: r.hash,
                                  fee: !!r.sponsored,
                                });
                                return true;
                              }}
                            />
                          )}
                          {paused ? (
                            unpause !== null ? (
                              <span className="tabular text-sm text-muted">
                                {uLeft ? `Unpauses in ${uLeft}` : "Ready to unpause: apply above"}
                              </span>
                            ) : (
                              <Button
                                variant="secondary"
                                onClick={async () => {
                                  const r = await run(sKey, "unpause", {
                                    envelope_id: b.id,
                                    spender: s.id,
                                  });
                                  if (!r) return;
                                  remember((l) =>
                                    l.unpausing.set(sKey, Date.now() + delaySecs * 1000),
                                  );
                                  queued(b, r.value, { unpause: { spender: s.id } });
                                  toast({
                                    ok: true,
                                    text: `${name} will be unpaused in ${later}. Any approver can cancel.`,
                                    tx: r.hash,
                                    fee: !!r.sponsored,
                                  });
                                }}
                              >
                                {label(sKey, "Unpause")}
                              </Button>
                            )
                          ) : (
                            <Button
                              variant="danger"
                              onClick={() =>
                                askPause({
                                  key: sKey,
                                  name: shortName(s.id),
                                  isBudget: false,
                                  budgetId: b.id,
                                  spenderId: s.id,
                                })
                              }
                            >
                              {label(sKey, "Pause")}
                            </Button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted">Payees</p>
                  {(() => {
                    const waiting = payeeChanges(b);
                    const waitingIds = new Set(waiting.map((c) => c.payee));
                    const current = [
                      ...b.payees,
                      ...[...(live?.payeesAdded ?? [])]
                        .filter((k) => k.startsWith(`${b.id}|`))
                        .map((k) => k.slice(b.id.length + 1)),
                    ].filter((p, i, a) => a.indexOf(p) === i && !waitingIds.has(p));
                    const justQueued = [...(live?.payeesQueued ?? [])]
                      .filter(([k]) => k.startsWith(`${b.id}|`))
                      .map(([k, at]) => [k.slice(b.id.length + 1), at] as const)
                      .filter(([p]) => !waitingIds.has(p) && !current.includes(p));
                    // The page's list lags a just-made change by a few seconds: keep its tag.
                    const tagged = (p: string) =>
                      b.nearComPayees.includes(p) || !!live?.nearComAdded.has(`${b.id}|${p}`);
                    return (
                      <>
                        {/* Every payee on the same row; one still waiting gets a small tag. */}
                        {current.map((p) => (
                          <PayeeRow key={p} id={p} nearCom={tagged(p)} />
                        ))}
                        {waiting.map((c) => {
                          const left = countdown(nsToMs(c.effectiveNs), now);
                          return (
                            <PayeeRow
                              key={c.id}
                              id={c.payee ?? ""}
                              nearCom={c.kind === "add_intents_payee"}
                              wait={left ? `Waiting ${left}` : "Ready"}
                            >
                              {changeActions(b, c, !left, "Make payable")}
                            </PayeeRow>
                          );
                        })}
                        {justQueued.map(([p, at]) => {
                          const left = countdown(at, now);
                          return (
                            <PayeeRow
                              key={p}
                              id={p}
                              nearCom={tagged(p)}
                              wait={left ? `Waiting ${left}` : "Ready"}
                            />
                          );
                        })}
                      </>
                    );
                  })()}
                  <div className="pt-2">
                    <AddPayee
                      budgetId={b.id}
                      symbol={b.symbol}
                      delay={later}
                      busy={busy === `p${b.id}`}
                      run={(method, args, opts) => run(`p${b.id}`, method, args, opts)}
                      onAdded={(payee, hash, nearCom, fee) => {
                        remember((l) => {
                          l.payeesQueued.set(`${b.id}|${payee}`, Date.now() + delaySecs * 1000);
                          if (nearCom) l.nearComAdded.add(`${b.id}|${payee}`);
                        });
                        toast({
                          ok: true,
                          text: `${shortName(payee)} can be paid in ${later}. Any approver can cancel.`,
                          tx: hash,
                          fee,
                        });
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Disclosure>

      <RejectSheet
        item={rejecting}
        onClose={() => setRejecting(null)}
        onReject={async (reason, forCause) => {
          const p = rejecting;
          if (!p) return;
          // Close first: a modal dialog would sit over the wallet's popup and block it.
          setRejecting(null);
          const budget = mine.find((b) => b.pending.some((x) => x.id === p.id));
          if (budget) await decide({ ...p, budget }, false, { reason, forCause });
        }}
      />

      <PauseConfirmDialog
        item={pauseConfirm}
        delay={later}
        onClose={() => setPauseConfirm(null)}
        onConfirm={async () => {
          const p = pauseConfirm;
          if (!p) return;
          setPauseConfirm(null);
          await doPause(p.key, p.budgetId, p.spenderId, p.name);
        }}
      />
    </div>
  );
}

function appliedText(c: InboxBudget["changes"][number]): string {
  if (c.kind === "unpause") {
    return c.spender ? `${shortName(c.spender)} is unpaused` : "The budget is unpaused";
  }
  return `Now in effect: ${c.text}`;
}

/** Small sheet: a reason the spender sees, and whether it counts against their record. */
function RejectSheet({
  item,
  onClose,
  onReject,
}: {
  item: { amount: string; payee: string } | null;
  onClose: () => void;
  onReject: (reason: string, forCause: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [forCause, setForCause] = useState(false);
  useEffect(() => {
    if (item) {
      setReason("");
      setForCause(false);
      ref.current?.showModal();
    } else ref.current?.close();
  }, [item]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-full max-w-md rounded-3xl p-0 shadow-xl max-sm:mb-0 max-sm:max-w-none max-sm:rounded-b-none"
    >
      <form
        method="dialog"
        className="space-y-5 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) onReject(reason.trim(), forCause);
        }}
      >
        <h2 className="text-xl font-semibold">
          Reject {item?.amount} to {item ? shortName(item.payee) : ""}?
        </h2>
        <label className="block space-y-1.5">
          <span className="font-medium">Reason</span>
          <input
            className="h-11.5 w-full rounded-xl border border-slate-300 px-3.5 outline-none focus:border-brand focus:ring-4 focus:ring-brand/20"
            placeholder="The spender sees this"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
          />
        </label>
        <label className="flex items-start gap-3 rounded-xl bg-surface p-3.5">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-rose-600"
            checked={forCause}
            onChange={(e) => setForCause(e.target.checked)}
          />
          <span>
            <span className="block font-medium">Counts against their record</span>
            <span className="block text-sm text-muted">
              Only for bad requests. It delays their next limit raise.
            </span>
          </span>
        </label>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <button
            type="submit"
            disabled={!reason.trim()}
            className="inline-flex h-11.5 flex-1 items-center justify-center rounded-xl bg-rose-600 font-semibold text-white hover:bg-rose-700 disabled:bg-rose-300"
          >
            Reject
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Pause confirmation dialog: warns that undoing takes time. */
function PauseConfirmDialog({
  item,
  delay,
  onClose,
  onConfirm,
}: {
  item: { name: string; isBudget: boolean } | null;
  delay: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (item) ref.current?.showModal();
    else ref.current?.close();
  }, [item]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-full max-w-sm rounded-2xl p-0 shadow-xl"
    >
      <div className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">Pause {item?.name}?</h2>
        <p className="text-muted">
          {item?.isBudget
            ? "All payments from this budget will stop. "
            : "Their payments will stop. "}
          Undoing takes {delay}.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            onClick={() => {
              // Close now, before the wallet opens: a modal dialog would sit over its popup.
              ref.current?.close();
              onConfirm();
            }}
          >
            Pause
          </Button>
        </div>
      </div>
    </dialog>
  );
}

/** "Raise limit" opens a small sheet: the new amount, what happens next, one button. */
function RaiseButton({
  name,
  limit,
  ceiling,
  delay,
  symbol,
  decimals,
  busy,
  onRaise,
}: {
  name: string;
  /** The current and highest limits, as shown ("10 tUSDC"). */
  limit: string;
  ceiling: string;
  delay: string;
  symbol: string;
  decimals: number;
  busy: boolean;
  onRaise: (amount: string) => Promise<boolean>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  const hint = useId();
  const meta = { symbol, decimals };
  const shown = (s: string) => toBase(s.split(" ")[0]?.replaceAll(",", "") ?? "", meta);
  const base = toBase(value, meta);
  const max = shown(ceiling);
  const now = shown(limit);
  const problem =
    !value.trim() || base === null
      ? null
      : max !== null && BigInt(base) > BigInt(max)
        ? `The most is ${ceiling}.`
        : now !== null && BigInt(base) <= BigInt(now)
          ? `Enter more than ${limit}.`
          : null;
  const ok = base !== null && problem === null;
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setValue("");
          ref.current?.showModal();
        }}
      >
        {busy ? "Confirm in wallet…" : "Raise limit"}
      </Button>
      <dialog
        ref={ref}
        className="m-auto w-full max-w-md rounded-3xl p-0 shadow-xl max-sm:mb-0 max-sm:max-w-none max-sm:rounded-b-none"
      >
        <form
          method="dialog"
          className="space-y-5 p-6"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!ok || !base) return;
            // Close first: a modal dialog would sit over the wallet's popup.
            ref.current?.close();
            await onRaise(base);
          }}
        >
          <div className="space-y-1">
            <h2 className="text-xl font-semibold">New limit for {name}</h2>
            <p className="text-muted">Now {limit}.</p>
          </div>
          <label className="block space-y-1.5">
            <span className="font-medium">Pays instantly up to</span>
            <span className="flex h-11.5 items-center rounded-xl border border-slate-300 focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/20">
              <input
                className="tabular h-full min-w-0 flex-1 rounded-xl px-3.5 outline-none"
                inputMode="decimal"
                autoComplete="off"
                aria-describedby={hint}
                aria-invalid={!!problem}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <span className="pr-3.5 text-muted">{symbol}</span>
            </span>
            <span id={hint} className={`block text-sm ${problem ? "text-rose-600" : "text-muted"}`}>
              {problem ?? `Max ${ceiling}. Applies in ${delay}. Any approver can cancel.`}
            </span>
          </label>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => ref.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={!ok}>
              {ok ? `Raise to ${value.trim()} ${symbol}` : "Raise"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/** One payee in Controls: the same row whether payable or still waiting (then a small tag). */
function PayeeRow({
  id,
  nearCom,
  wait,
  children,
}: {
  id: string;
  nearCom: boolean;
  /** "Waiting 0:55" or "Ready" while the add waits; nothing once payable. */
  wait?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1">
      <span className="flex flex-wrap items-center gap-2">
        <Person id={id} />
        {nearCom && <Pill tone="blue">near.com</Pill>}
        {wait && (
          <Pill tone="amber">
            <span className="tabular">{wait}</span>
          </Pill>
        )}
      </span>
      {children}
    </div>
  );
}

type Run = (
  method: string,
  args: object,
  opts?: { receiverId?: string; deposit?: string },
) => Promise<{ hash: string; sponsored?: boolean } | null>;

/**
 * Add a payee in one step, from one box: the app tells a NEAR account from a wallet address.
 * - A NEAR account the budget's token doesn't know yet (NEP-145) can't receive it, so the same
 *   click first pays their one-time token registration (`storage_deposit`), then approves them
 *   (`approve_payee`, payable after the waiting period). The wallet asks once per transaction.
 * - On a contract that can pay near.com, a wallet address (`0x…`, MetaMask and others) is paid
 *   into its near.com balance (`approve_intents_payee`): no token setup. A NEAR account can be
 *   paid there too, by choice. Pasting a `0x…` never makes a plain NEAR payee by mistake.
 */
function AddPayee({
  budgetId,
  symbol,
  delay,
  busy,
  run,
  onAdded,
}: {
  budgetId: string;
  symbol: string;
  delay: string;
  busy: boolean;
  run: Run;
  onAdded: (payee: string, hash: string, nearCom: boolean, fee: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [step, setStep] = useState<"register" | "approve" | null>(null);
  // null until read; false when this contract can't pay near.com.
  const [canNearCom, setCanNearCom] = useState<boolean | null>(null);
  // A NEAR account paid into its near.com balance instead (a wallet address always is).
  const [nameToNearCom, setNameToNearCom] = useState(false);
  const typed = nearComAddress(value);
  const wallet = !!canNearCom && isWalletAddress(typed);
  const nearCom = !!canNearCom && (wallet || nameToNearCom);
  const payee = nearCom ? typed : value.trim().toLowerCase();
  const valid = isAccountId(payee);
  const { reg } = useRegistration(nearCom ? null : token, valid ? payee : null);
  const needsSetup = !nearCom && reg.state === "missing";

  const close = () => {
    setValue("");
    setNameToNearCom(false);
    setOpen(false);
  };

  const add = async () => {
    if (needsSetup && token) {
      setStep("register");
      const r = await run(
        "storage_deposit",
        { account_id: payee, registration_only: true },
        { receiverId: token, deposit: reg.deposit },
      );
      if (!r) {
        setStep(null);
        return;
      }
    }
    setStep("approve");
    const method = nearCom ? "approve_intents_payee" : "approve_payee";
    const r = await run(method, { envelope_id: budgetId, payee });
    setStep(null);
    if (!r) return;
    onAdded(payee, r.hash, nearCom, !!r.sponsored);
    close();
  };

  useEffect(() => {
    if (!open || token) return;
    view<{ token_id: string } | null>(CONTRACT, "get_envelope", { envelope_id: budgetId })
      .then((b) => setToken(b?.token_id ?? null))
      .catch(() => {});
  }, [open, token, budgetId]);

  useEffect(() => {
    if (!open || canNearCom !== null) return;
    getConfig()
      .then((c) => setCanNearCom(!!c.intents_contract))
      .catch(() => setCanNearCom(false));
  }, [open, canNearCom]);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Add payee
      </Button>
    );
  }
  const checking =
    !nearCom && valid && (reg.state === "checking" || (token === null && reg.state === "idle"));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          // Its own row in a narrow panel (the budget's People list), one line with the buttons in Controls.
          className="h-11.5 min-w-0 grow basis-56 rounded-xl border border-slate-300 px-3.5 outline-none focus:border-brand focus:ring-4 focus:ring-brand/20"
          placeholder={canNearCom ? "name.near or 0x… address" : "name.near"}
          aria-label="Who to pay"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: the field opens on the user's own click
          autoFocus
        />
        {/* Add and Cancel move together, under the box when the panel is narrow. */}
        <span className="flex gap-2">
          <Button disabled={!valid || busy || checking || canNearCom === null} onClick={add}>
            {busy
              ? step === "register" && needsSetup
                ? "Confirm 1 of 2 in wallet…"
                : needsSetup
                  ? "Confirm 2 of 2 in wallet…"
                  : "Confirm in wallet…"
              : "Add"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted" aria-live="polite">
        {payee && !valid ? (
          <span className="text-rose-700">
            {canNearCom
              ? "That isn’t a NEAR account or a wallet address."
              : "That isn’t a NEAR account."}
          </span>
        ) : nearCom && valid ? (
          <>
            <Pill tone="blue">near.com</Pill>
            <span>
              {wallet ? "Wallet address. " : ""}Paid into their near.com balance; they withdraw
              there with the same wallet. Payable after {delay}.
            </span>
          </>
        ) : needsSetup ? (
          `${shortName(payee)} also needs a one-time ${symbol} setup (${nearAmount(reg.deposit)}). Your wallet asks twice.`
        ) : (
          `Payable after ${delay}. Any approver can cancel before then.`
        )}
      </p>
      {canNearCom && valid && !wallet && (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={nameToNearCom}
            disabled={busy}
            onChange={(e) => setNameToNearCom(e.target.checked)}
          />
          Pay into their near.com balance instead
        </label>
      )}
    </div>
  );
}

/**
 * "Add payee" on a budget's page, for its approvers: where someone looks first when they want to
 * pay a new person. Same form as in Approvals → Controls, where the new payee is made payable.
 */
export function BudgetAddPayee({
  budgetId,
  symbol,
  approvers,
  delaySecs,
}: {
  budgetId: string;
  symbol: string;
  approvers: string[];
  delaySecs: number;
}) {
  const { accountId, call } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!accountId || !approvers.includes(accountId)) return null;
  const later = duration(delaySecs);
  const run: Run = async (method, args, opts = {}) => {
    if (busy) return null;
    setBusy(true);
    const r = await call(method, args, { gasTgas: 30, ...opts });
    setBusy(false);
    if (!r.ok) toast({ ok: false, text: r.error });
    return r.ok ? r : null;
  };
  return (
    <div className="pt-2">
      <AddPayee
        budgetId={budgetId}
        symbol={symbol}
        delay={later}
        busy={busy}
        run={run}
        onAdded={(payee, _hash, _nearCom, fee) =>
          toast({
            ok: true,
            text: `${shortName(payee)} can be paid in ${later}. Make them payable in Approvals.`,
            href: "/approvals",
            fee,
          })
        }
      />
    </div>
  );
}
