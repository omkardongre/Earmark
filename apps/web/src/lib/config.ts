// Public deployment settings. Defaults point at the testnet demo; override with NEXT_PUBLIC_* env.
export type Network = "testnet" | "mainnet";

export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as Network;
export const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT ?? "budgets.earmark.testnet";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ??
  (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");

/** FastNEAR transactions API: used only to find the transaction behind each event. */
export const TX_API =
  NETWORK === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com";

export const EXPLORER =
  NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;

/** Where a DAO proposal opens. Trezu on mainnet; the explorer on testnet (Trezu is mainnet only). */
export function proposalUrl(dao: string, id: string | number): string {
  return NETWORK === "mainnet" ? `https://trezu.app/${dao}/requests?id=${id}` : accountUrl(dao);
}
