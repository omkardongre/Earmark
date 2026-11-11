"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CONTRACT } from "@/lib/config";
import { BLOCKED, shortName, toBase } from "@/lib/format";
import { view } from "@/lib/near";
import type { PayPrefill } from "@/lib/request-link";
import { isAccountId, nearAmount, storageBalanceOf, storageBounds } from "@/lib/token";
import type { BlockReason, RequestStatus, Tier, TokenMeta } from "@/lib/types";
import { Avatar, Button, ButtonLink, Pill } from "./ui";
import { useWallet } from "./wallet";

type Check = { tier: Tier | null; blocked: BlockReason | null };

const TIER: Record<
  Tier,
  { label: string; hint: string; tone: "green" | "amber" | "blue"; button: (a: string) => string }
> = {
  auto: {
    label: "Pays now",
    hint: "Within your limit, so it goes out at once.",
    tone: "green",
    button: (a) => `Pay ${a}`,
  },
  one_approver: {
    label: "Needs one approval",
    hint: "An approver gets it in their inbox.",
    tone: "amber",
    button: () => "Ask for approval",
  },
  escalate: {
    label: "Goes to a DAO vote",
    hint: "Too big for this budget, so the DAO votes. The treasury pays it, not the budget.",
    tone: "blue",
    button: () => "Send to DAO vote",
  },
  trusted: {
    label: "Pays now",
    hint: "A trusted contributor of this budget, so no approval is needed.",
    tone: "green",
    button: (a) => `Pay ${a}`,
  },
};

type Done = { status: RequestStatus | null; amount: string; payee: string; id: string; tx: string };

const doneText = (d: Done) =>
  d.status === "paid"
    ? `Paid ${d.amount} to ${d.payee}`
    : d.status === "pending_approval"
      ? `Sent for approval: ${d.amount} to ${d.payee}`
      : d.status === "escalated" || d.status === "escalating"
        ? `Sent to a DAO vote: ${d.amount} to ${d.payee}`
        : d.status === "failed"
          ? "The payment didn’t go through. Nothing was spent."
          : "Sent.";

/** The form's fields live together, so closing keeps all of them and sending clears all. */
type Draft = { amount: string; payee: string; work: string; memo: string };
const EMPTY: Draft = { amount: "", payee: "", work: "", memo: "" };

/** Above this many payees the list gets a search box. */
const SEARCH_FROM = 6;

const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 24);

export function PaySheet({
  budgetId,
  token,
  payees,
  spenders,
  meta,
  prefill = null,
}: {
  budgetId: string;
  /** The budget's token: payees must be registered with it (NEP-145) to receive payments. */
  token: string;
  payees: string[];
  spenders: string[];
  meta: TokenMeta;
  /** From an "Ask to be paid" link: opens the form filled in, once, for a spender. */
  prefill?: PayPrefill | null;
}) {
  const { accountId, connect, call } = useWallet();
  const dialog = useRef<HTMLDialogElement>(null);
  // Nobody is picked up front, so nobody gets paid by mistake.
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // One id per payment: a retry after a network error reuses it, so it can never pay twice (R5).
  const requestId = useRef("");
  // Set while the sheet is hidden for the wallet popup, so that close isn't treated as "Done".
  const forWallet = useRef(false);

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const { amount, payee, work, memo } = draft;
  const base = toBase(amount, meta);
  const { reg, recheck } = useRegistration(token, payee || null);

  useEffect(() => {
    setCheck(null);
    if (!accountId || !payee || !base || !work.trim()) return;
    const t = setTimeout(async () => {
      try {
        setCheck(
          await view<Check>(CONTRACT, "check_spend", {
            envelope_id: budgetId,
            spender: accountId,
            request_id: requestId.current,
            payee,
            amount: base,
            work_ref: work.trim(),
          }),
        );
      } catch {
        setCheck({ tier: null, blocked: "invalid_input" });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [accountId, budgetId, payee, base, work]);

  // A request link fills the form and opens it once the lead is signed in. The link is dropped
  // from the address bar, so a reload doesn't open it again; nothing is sent until they confirm.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!prefill || prefilled.current || !accountId || !spenders.includes(accountId)) return;
    prefilled.current = true;
    setDraft(prefill);
    requestId.current = newId();
    window.history.replaceState(null, "", window.location.pathname);
    dialog.current?.showModal();
  }, [prefill, accountId, spenders]);

  // Signed in but not a spender here: nothing to pay with.
  if (accountId && !spenders.includes(accountId)) return null;

  const open = () => {
    if (!accountId) {
      void connect();
      return;
    }
    if (!requestId.current) requestId.current = newId();
    setDone(null);
    setError(null);
    dialog.current?.showModal();
  };

  // The success card already said what happened, and the new row is on the page: no toast.
  const finish = () => {
    requestId.current = "";
    setDraft(EMPTY);
    setDone(null);
    setError(null);
  };

  const submit = async () => {
    if (!base || !check?.tier) return;
    setBusy(true);
    setError(null);
    const id = requestId.current;
    // A modal dialog sits in the browser's top layer and makes the rest of the page inert,
    // including the wallet's own popup. Step aside while the wallet asks, then come back.
    forWallet.current = true;
    dialog.current?.close();
    const r = await call(
      "request_spend",
      {
        envelope_id: budgetId,
        request_id: id,
        payee,
        amount: base,
        memo: memo.trim(),
        work_ref: work.trim(),
      },
      // Wallets must hold prepaid gas × the worst-case gas price up front (~0.1 NEAR per
      // 100 Tgas). A request burns 4–15 Tgas; an escalation reserves 55 Tgas for get_policy and
      // add_proposal, so 100 Tgas covers every tier (the S3 escalation runs on 100).
      { gasTgas: 100 },
    );
    setBusy(false);
    forWallet.current = false;
    if (r.ok) {
      setDone({
        status: (r.value as RequestStatus | null) ?? null,
        amount: `${amount.trim()} ${meta.symbol}`,
        payee: shortName(payee),
        id,
        tx: r.hash,
      });
    } else {
      // Same request id on retry, so a payment that did go through can't be sent twice.
      setError(r.error);
    }
    dialog.current?.showModal();
  };

  /** Hides the modal sheet while the wallet asks (its popup can't sit above a modal). */
  const aside = async <T,>(fn: () => Promise<T>): Promise<T> => {
    forWallet.current = true;
    dialog.current?.close();
    try {
      return await fn();
    } finally {
      forWallet.current = false;
      dialog.current?.showModal();
    }
  };

  const tier = check?.tier ? TIER[check.tier] : null;
  const unregistered = reg.state === "missing";
  const filled = Boolean(payee && base && work.trim());
  const amountText = `${amount.trim() || "0"} ${meta.symbol}`;

  return (
    <>
      <Button onClick={open}>{accountId ? "New payment" : "Sign in to pay"}</Button>
      <dialog
        ref={dialog}
        aria-labelledby={`pay-${budgetId}`}
        className="m-auto w-full max-w-md rounded-3xl p-0 shadow-xl max-sm:mb-0 max-sm:max-w-none max-sm:rounded-b-none"
        onClose={() => {
          if (forWallet.current) return;
          if (done) finish();
        }}
      >
        {done ? (
          <div className="space-y-6 p-6 text-center">
            <div
              className={`rounded-2xl px-4 py-8 text-white ${
                done.status === "failed"
                  ? "bg-rose-600"
                  : "bg-gradient-to-br from-emerald-500 to-emerald-600"
              }`}
            >
              <div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-white/25 text-2xl font-bold">
                {done.status === "failed" ? "!" : "✓"}
              </div>
              <p className="text-lg font-semibold">{doneText(done)}</p>
            </div>
            <div className="flex gap-2">
              <ButtonLink
                href={`/payments/${done.id}?tx=${done.tx}`}
                variant="secondary"
                className="flex-1"
                onClick={() => dialog.current?.close()}
              >
                View
              </ButtonLink>
              <Button className="flex-1" onClick={() => dialog.current?.close()}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form method="dialog" className="space-y-5 p-6" onSubmit={(e) => e.preventDefault()}>
            <div className="flex items-center justify-between">
              <h2 id={`pay-${budgetId}`} className="text-xl font-semibold">
                New payment
              </h2>
              <button
                type="button"
                className="grid size-9 place-items-center rounded-full text-muted hover:bg-slate-100 hover:text-ink"
                onClick={() => dialog.current?.close()}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {payees.length === 0 ? (
              <p className="rounded-xl bg-surface p-4 text-muted">
                No one can be paid from this budget yet. Ask an approver to add a payee.
              </p>
            ) : (
              <>
                <label className="block">
                  <span className="sr-only">Amount</span>
                  <span className="flex items-baseline justify-center gap-2 rounded-2xl bg-surface px-4 py-5 focus-within:ring-2 focus-within:ring-brand/30">
                    <input
                      className="tabular w-full min-w-0 bg-transparent text-center text-4xl font-bold tracking-tight outline-none placeholder:text-slate-300"
                      inputMode="decimal"
                      placeholder="0"
                      value={amount}
                      onChange={(e) => set("amount")(e.target.value)}
                      autoFocus
                    />
                    <span className="text-lg font-semibold text-muted">{meta.symbol}</span>
                  </span>
                </label>

                <PayeePicker payees={payees} value={payee} onChange={set("payee")} />

                <Field label="Link to the work" hint="The same work can’t be paid twice.">
                  <input
                    className={input}
                    placeholder="https://"
                    value={work}
                    onChange={(e) => set("work")(e.target.value)}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>

                <details open={memo !== ""}>
                  <summary className="cursor-pointer list-none text-sm font-medium text-brand hover:underline [&::-webkit-details-marker]:hidden">
                    + Add a note
                  </summary>
                  <input
                    className={`${input} mt-2`}
                    value={memo}
                    onChange={(e) => set("memo")(e.target.value)}
                    maxLength={200}
                    aria-label="Note"
                    placeholder="What it's for (optional)"
                  />
                </details>

                {unregistered && (
                  <RegisterPayee
                    token={token}
                    payee={payee}
                    deposit={reg.deposit}
                    symbol={meta.symbol}
                    aside={aside}
                    onDone={recheck}
                  />
                )}

                <div className="min-h-12" aria-live="polite">
                  {check?.blocked ? (
                    <p className="flex items-start gap-2 text-rose-700">
                      <Pill tone="red">Can’t send</Pill>
                      <span>{BLOCKED[check.blocked]}</span>
                    </p>
                  ) : tier ? (
                    <p className="flex items-start gap-2 text-muted">
                      <Pill tone={tier.tone}>{tier.label}</Pill>
                      <span>{tier.hint}</span>
                    </p>
                  ) : filled ? (
                    <p className="text-sm text-muted">Checking…</p>
                  ) : (
                    <p className="text-sm text-muted">
                      {payee
                        ? "Enter the amount and the work link to see what happens."
                        : "Choose who to pay, then enter the amount and the work link."}
                    </p>
                  )}
                </div>

                {error && (
                  <p className="rounded-xl bg-rose-50 px-4 py-3 text-rose-700" role="alert">
                    {error} You can try again; it won’t pay twice.
                  </p>
                )}

                <div className="space-y-2">
                  <Button
                    className="w-full"
                    disabled={!check?.tier || busy || unregistered}
                    onClick={submit}
                  >
                    {busy ? "Confirm in your wallet…" : tier ? tier.button(amountText) : "Send"}
                  </Button>
                  {tier && (
                    // The wallet screen only shows the contract, so say here what it signs.
                    <p className="text-center text-sm text-muted">
                      {check?.tier === "auto" || check?.tier === "trusted"
                        ? `Your wallet confirms ${amountText} to ${shortName(payee)}.`
                        : check?.tier === "one_approver"
                          ? `Your wallet signs the request. ${shortName(payee)} is paid when an approver says yes.`
                          : `Your wallet signs the request. ${shortName(payee)} is paid if the DAO votes yes.`}
                    </p>
                  )}
                </div>
              </>
            )}
          </form>
        )}
      </dialog>
    </>
  );
}

/**
 * Who to pay: the budget's approved payees as a list of choices (native radios, so keyboard and
 * screen readers work as usual), each with its full account. A search box shows for long lists.
 */
function PayeePicker({
  payees,
  value,
  onChange,
}: {
  payees: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [q, setQ] = useState("");
  const name = useId();
  const term = q.trim().toLowerCase();
  const matches = term ? payees.filter((p) => p.toLowerCase().includes(term)) : payees;
  // No scroll inside the sheet: a short list shows whole, a long one shows its first matches
  // (plus the one picked) and the search box finds the rest.
  const top = matches.slice(0, SEARCH_FROM);
  const list = value && matches.includes(value) && !top.includes(value) ? [...top, value] : top;
  const hidden = matches.length - top.length;
  return (
    <fieldset className="space-y-1.5">
      <legend className="font-medium">Pay to</legend>
      {payees.length > SEARCH_FROM && (
        <input
          type="search"
          className={input}
          placeholder="Search payees"
          aria-label="Search payees"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
        />
      )}
      <div className="divide-y divide-line rounded-xl border border-slate-300">
        {list.length === 0 ? (
          <p className="px-3.5 py-3 text-sm text-muted">No payee matches “{q}”.</p>
        ) : (
          list.map((p) => (
            <label
              key={p}
              className={`flex cursor-pointer items-center gap-3 px-3.5 py-2.5 hover:bg-slate-50 ${
                value === p ? "bg-brand-soft" : ""
              }`}
            >
              <input
                type="radio"
                name={name}
                value={p}
                checked={value === p}
                onChange={() => onChange(p)}
                className="size-4 accent-brand"
              />
              <Avatar id={p} />
              <span className="min-w-0">
                <span className="block font-medium">{shortName(p)}</span>
                <span className="block break-all text-sm text-muted">{p}</span>
              </span>
            </label>
          ))
        )}
      </div>
      <span className="block text-sm text-muted">
        {hidden > 0
          ? `${hidden} more: search to find them.`
          : "Not listed? An approver can add them."}
      </span>
    </fieldset>
  );
}

const input =
  "h-11.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 outline-none focus:border-brand focus:ring-4 focus:ring-brand/20";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is passed in as children, inside the label
    <label className="block space-y-1.5">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="block text-sm text-muted">{hint}</span>}
    </label>
  );
}

export type Registration =
  | { state: "idle" | "checking" | "registered" | "unknown" }
  | { state: "missing"; deposit: string };

/**
 * Whether `account` is registered with `token` (NEP-145 `storage_balance_of`), and the deposit a
 * registration needs (`storage_balance_bounds.min`) when it isn't. "unknown" when the token can't
 * be read: then nothing is blocked. `recheck` reads it again, e.g. after registering.
 */
export function useRegistration(token: string | null, account: string | null) {
  const [reg, setReg] = useState<Registration>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const recheck = useCallback(() => setTick((t) => t + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` asks for a fresh read
  useEffect(() => {
    if (!token || !account || !isAccountId(account)) {
      setReg({ state: "idle" });
      return;
    }
    let live = true;
    setReg({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const bal = await storageBalanceOf(token, account);
        if (!live) return;
        if (bal) {
          setReg({ state: "registered" });
          return;
        }
        const { min } = await storageBounds(token);
        if (live) setReg({ state: "missing", deposit: min });
      } catch {
        if (live) setReg({ state: "unknown" });
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [token, account, tick]);
  return { reg, recheck };
}

/**
 * A payee the token doesn't know yet can't receive it, so the payment would fail. One click pays
 * the token's registration deposit for them (`storage_deposit`, registration only), signed by the
 * connected wallet. `aside` lets a modal step out of the way of the wallet popup.
 */
export function RegisterPayee({
  token,
  payee,
  deposit,
  symbol,
  aside = (fn) => fn(),
  onDone,
}: {
  token: string;
  payee: string;
  deposit: string;
  symbol: string;
  aside?: <T>(fn: () => Promise<T>) => Promise<T>;
  onDone: () => void;
}) {
  const { call } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const register = async () => {
    setBusy(true);
    setError(null);
    const r = await aside(() =>
      call(
        "storage_deposit",
        { account_id: payee, registration_only: true },
        { receiverId: token, deposit, gasTgas: 30 },
      ),
    );
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error);
  };
  return (
    <div className="space-y-3 rounded-xl bg-amber-50 px-4 py-3.5" role="status">
      <p className="text-[15px]">
        <span className="font-medium">{shortName(payee)}</span> can’t receive {symbol} yet. The
        token needs a one-time registration for them.
      </p>
      {error && <p className="text-sm text-rose-700">{error}</p>}
      <Button variant="secondary" className="w-full" disabled={busy} onClick={register}>
        {busy ? "Confirm in your wallet…" : `Register payee (${nearAmount(deposit)})`}
      </Button>
    </div>
  );
}
