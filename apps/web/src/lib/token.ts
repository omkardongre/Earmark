// NEP-141 / NEP-145 helpers for a budget's token: exact amounts, and whether an account is
// registered with the token (a payee must be, or the payment to them fails). Server and browser.
import { view } from "./near";

/** NEP-145 `storage_balance_of`: null when the account isn't registered. */
export type StorageBalance = { total: string; available: string };
/** NEP-145 `storage_balance_bounds`. */
export type StorageBounds = { min: string; max: string | null };

export const storageBalanceOf = (token: string, account: string) =>
  view<StorageBalance | null>(token, "storage_balance_of", { account_id: account });

const bounds = new Map<string, Promise<StorageBounds>>();
/** The deposit a registration needs (`min`), read from the token once per page load. */
export function storageBounds(token: string): Promise<StorageBounds> {
  let b = bounds.get(token);
  if (!b) {
    b = view<StorageBounds>(token, "storage_balance_bounds");
    // A failed read shouldn't stick.
    b.catch(() => bounds.delete(token));
    bounds.set(token, b);
  }
  return b;
}

/** Base units -> exact decimal text with no grouping ("1234.5"), for files and wallets. */
export function exactUnits(amount: string | bigint, decimals: number): string {
  const v = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / base}${frac ? `.${frac}` : ""}`;
}

/** yoctoNEAR -> "0.00125 NEAR". */
export const nearAmount = (yocto: string) => `${exactUnits(yocto, 24)} NEAR`;

/** NEAR account id rules (named or 64-char implicit). */
export const isAccountId = (s: string) =>
  s.length >= 2 &&
  s.length <= 64 &&
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
