// near.com payees (Feature 3): Earmark pays them into their NEAR Intents balance, and they
// withdraw on near.com with the same wallet (MetaMask, Phantom, passkey or a NEAR wallet) to
// any chain. Earmark's part ends at the credit. Server and browser.
import { CONTRACT } from "./config";
import { view } from "./near";

export const NEAR_COM = "https://near.com";

/**
 * A near.com address as typed or pasted: near.com shows `0x…` for wallets like MetaMask, maybe
 * with a `nearcom:` prefix (as Trezu writes it). Intents ids are lowercase; a mixed-case `0x…`
 * would be refused, so it's lowercased here.
 */
export const nearComAddress = (s: string) =>
  s
    .trim()
    .replace(/^nearcom:/i, "")
    .toLowerCase();

/** The contract's near.com payees in a budget; none on a contract without near.com payouts. */
export const listIntentsPayees = (budgetId: string) =>
  view<string[]>(CONTRACT, "list_intents_payees", { envelope_id: budgetId }).catch(
    () => [] as string[],
  );

/** Whether this payment goes (or went) into the payee's near.com balance. */
export const isIntentsRequest = (requestId: string) =>
  view<boolean>(CONTRACT, "is_intents_request", { request_id: requestId }).catch(() => false);

/** What `account` holds of `token` on near.com (NEP-245 `mt_balance_of` on Intents). */
export const nearComBalance = (intents: string, account: string, token: string) =>
  view<string>(intents, "mt_balance_of", { account_id: account, token_id: `nep141:${token}` });
