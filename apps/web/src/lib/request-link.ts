// "Ask to be paid" links: a contributor fills in amount, work link and note; the link opens the
// lead's pay form filled in. Nothing is stored: the URL carries the fields, and they are only
// suggestions. The lead still reviews them, the wallet signs, and the contract checks every rule.
import { toBase } from "./format";
import type { TokenMeta } from "./types";

export type PayPrefill = { payee: string; amount: string; work: string; memo: string };

/** The contract's limit for `work_ref` and `memo` (request.rs `MAX_TEXT_BYTES`). */
const MAX_TEXT_BYTES = 256;
/** The pay form's note box (`maxLength`). */
export const MAX_NOTE = 200;

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** Drops control characters and runs of spaces: the text came from a link anyone can edit. */
const clean = (s: string) =>
  Array.from(s, (c) => {
    const n = c.charCodeAt(0);
    return n < 32 || n === 127 ? " " : c;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** Path to the budget page that opens the pay form with these fields. */
export function requestPath(budgetId: string, p: PayPrefill): string {
  const q = new URLSearchParams({ pay: "1", payee: p.payee, amount: p.amount, work: p.work });
  if (p.memo) q.set("note", p.memo);
  return `/budgets/${budgetId}?${q}`;
}

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * The fields from a request link, or null if it isn't one or doesn't fit this budget: the payee
 * must be one of its payees, the amount a valid token amount, the texts within the contract's
 * limits. A bad link opens the budget page as usual.
 */
export function readPrefill(q: Query, payees: string[], meta: TokenMeta): PayPrefill | null {
  if (one(q.pay) !== "1") return null;
  const payee = one(q.payee).trim();
  const amount = one(q.amount).trim();
  const work = clean(one(q.work));
  const memo = clean(one(q.note)).slice(0, MAX_NOTE);
  if (!payees.includes(payee) || !toBase(amount, meta)) return null;
  if (!work || bytes(work) > MAX_TEXT_BYTES || bytes(memo) > MAX_TEXT_BYTES) return null;
  return { payee, amount, work, memo };
}

/** Same checks for the contributor's form, as a message to show (null when it's fine). */
export function prefillProblem(p: PayPrefill, meta: TokenMeta): string | null {
  if (!p.payee) return "Choose who you are.";
  if (!toBase(p.amount, meta)) return `Enter an amount in ${meta.symbol}.`;
  if (!clean(p.work)) return "Add a link to the work.";
  if (bytes(clean(p.work)) > MAX_TEXT_BYTES) return "The work link is too long.";
  return null;
}
