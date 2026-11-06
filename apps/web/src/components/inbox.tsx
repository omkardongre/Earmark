"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ago, duration, STATUS, shortName, toBase } from "@/lib/format";
import type { RequestStatus } from "@/lib/types";
import { useToast } from "./toast";
import {
  Button,
  ButtonLink,
  Card,
  Disclosure,
  Empty,
  ExternalLink,
  Person,
  Pill,
  Section,
} from "./ui";
import { useWallet } from "./wallet";

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
  pending: {
    id: string;
    spender: string;
    payee: string;
    amount: string;
    work: string;
    memo: string;
    createdNs: string;
    expiresNs: string;
  }[];
  recent: Recent[];
  changes: {
    id: string;
    kind: string;
    spender: string | null;
    text: string;
    by: string;
    effectiveNs: string;
  }[];
  spenders: {
    id: string;
    paused: boolean;
    pausedBy?: string;
    pausedNs?: string;
    limit: string;
    eligible: boolean;
  }[];
};

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
};
const KEEP_MS = 20_000;
const fresh = (): Local => ({
  at: 0,
  decided: new Map(),
  paused: new Map(),
  unpausing: new Map(),
  changesGone: new Set(),
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
  const run = async (key: string, method: string, args: object) => {
    if (busy) return null;
    setBusy(key);
    const r = await call(method, args, { gasTgas: method === "approve" ? 100 : 30 });
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
  const changesOf = (b: InboxBudget) => b.changes.filter((c) => !live?.changesGone.has(c.id));
  const waitingChanges = mine.reduce((n, b) => n + changesOf(b).length, 0);

  const isPaused = (key: string, server: boolean) => live?.paused.get(key) ?? server;
  /** When a queued unpause applies (ms), from the chain or from this screen's own action. */
  const unpauseAt = (b: InboxBudget, spender: string | null): number | null => {
    const c = changesOf(b).find((x) => x.kind === "unpause" && x.spender === spender);
    if (c) return nsToMs(c.effectiveNs);
    return live?.unpausing.get(`${b.id}|${spender ?? ""}`) ?? null;
  };

  const label = (key: string, idle: string) => (busy === key ? "Confirm in wallet…" : idle);

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
    });
  };

  return (
    <div className="space-y-10">
      <Section title="Waiting for you">
        {pending.length === 0 ? (
          <Empty>Nothing needs you right now ✓</Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {pending.map((p) => {
              const own = p.spender === accountId;
              const left = countdown(nsToMs(p.expiresNs), now);
              return (
                <Card key={p.id} className="flex flex-col gap-4 p-5">
                  <div className="space-y-1">
                    <p className="text-sm text-muted">{p.budget.name}</p>
                    <p className="tabular text-3xl font-bold tracking-tight">{p.amount}</p>
                    <p className="flex flex-wrap items-center gap-1.5 text-muted">
                      <Person id={p.spender} /> wants to pay <Person id={p.payee} />
                    </p>
                  </div>
                  <div className="space-y-1 text-[15px]">
                    <p className="break-words">
                      {/^https?:\/\//.test(p.work) ? (
                        <ExternalLink href={p.work}>
                          {p.work.replace(/^https?:\/\//, "")}
                        </ExternalLink>
                      ) : (
                        p.work
                      )}
                    </p>
                    {p.memo && <p className="text-muted">“{p.memo}”</p>}
                    <p className="text-sm text-muted">
                      {ago(p.createdNs)} · {left ? `expires in ${left}` : "expired"}
                    </p>
                  </div>
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
                          });
                        }}
                      >
                        {label(p.id, "Release")}
                      </Button>
                    ) : own ? (
                      <p className="text-sm text-muted">
                        Your own payment. Another approver decides.
                      </p>
                    ) : (
                      <>
                        <Button className="flex-1" onClick={() => decide(p, true)}>
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
        open={waitingChanges > 0}
        hint={
          waitingChanges > 0 ? (
            <Pill tone="amber">
              {waitingChanges} change{waitingChanges === 1 ? "" : "s"} waiting
            </Pill>
          ) : (
            "Pause, limits"
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
                          toast({
                            ok: true,
                            text: `The budget unpauses in ${later}. Any approver can cancel.`,
                            tx: r.hash,
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

                {changesOf(b).length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted">Waiting changes</p>
                    {changesOf(b).map((c) => {
                      const left = countdown(nsToMs(c.effectiveNs), now);
                      const cKey = `c${c.id}`;
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
                          <div className="flex gap-2">
                            {!left && (
                              <Button
                                variant="secondary"
                                onClick={async () => {
                                  const r = await run(cKey, "apply_change", { change_id: c.id });
                                  if (!r) return;
                                  remember((l) => {
                                    l.changesGone.add(c.id);
                                    if (c.kind === "unpause") {
                                      l.paused.set(`${b.id}|${c.spender ?? ""}`, false);
                                    }
                                  });
                                  toast({ ok: true, text: appliedText(c), tx: r.hash });
                                }}
                              >
                                {label(cKey, "Apply")}
                              </Button>
                            )}
                            <Button
                              variant="danger"
                              onClick={async () => {
                                const r = await run(`x${c.id}`, "cancel_change", {
                                  change_id: c.id,
                                });
                                if (!r) return;
                                remember((l) => {
                                  l.changesGone.add(c.id);
                                  l.unpausing.delete(`${b.id}|${c.spender ?? ""}`);
                                });
                                toast({ ok: true, text: `Cancelled: ${c.text}`, tx: r.hash });
                              }}
                            >
                              {label(`x${c.id}`, "Cancel")}
                            </Button>
                          </div>
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
                            {!paused && s.eligible && <Pill tone="green">Can get a raise</Pill>}
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
                              ceiling={b.ceiling}
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
                                toast({
                                  ok: true,
                                  text: `${name}’s new limit applies in ${later}. Any approver can cancel.`,
                                  tx: r.hash,
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
                                  toast({
                                    ok: true,
                                    text: `${name} will be unpaused in ${later}. Any approver can cancel.`,
                                    tx: r.hash,
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

function RaiseButton({
  ceiling,
  symbol,
  decimals,
  busy,
  onRaise,
}: {
  ceiling: string;
  symbol: string;
  decimals: number;
  busy: boolean;
  onRaise: (amount: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Raise limit
      </Button>
    );
  }
  const base = toBase(value, { symbol, decimals });
  return (
    <span className="flex items-center gap-2">
      <input
        className="tabular h-11.5 w-28 rounded-xl border border-slate-300 px-3"
        inputMode="decimal"
        placeholder={`max ${ceiling}`}
        aria-label="New limit"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        disabled={!base}
        onClick={async () => {
          if (base && (await onRaise(base))) {
            setOpen(false);
            setValue("");
          }
        }}
      >
        {busy ? "Confirm in wallet…" : "Queue"}
      </Button>
    </span>
  );
}
