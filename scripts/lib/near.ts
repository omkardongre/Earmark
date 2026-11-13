// Shared helpers for the Node scripts: keyless RPC views and, for testnet setup only, signing
// with keys from the NEAR CLI legacy keychain (~/.near-credentials).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Account, actions, JsonRpcProvider, type KeyPairString } from "near-api-js";

export type Network = "testnet" | "mainnet";

export const RPC: Record<Network, string> = {
  testnet: process.env.NEAR_RPC_TESTNET ?? "https://rpc.testnet.fastnear.com",
  mainnet: process.env.NEAR_RPC_MAINNET ?? "https://rpc.mainnet.fastnear.com",
};

/** Archival nodes, tried in order: regular nodes forget transactions after a few days. */
export const ARCHIVAL_RPC: Record<Network, string[]> = {
  testnet: [
    process.env.NEAR_ARCHIVAL_RPC_TESTNET ?? "https://archival-rpc.testnet.fastnear.com",
    "https://archival-rpc.testnet.near.org",
  ],
  mainnet: [
    process.env.NEAR_ARCHIVAL_RPC_MAINNET ?? "https://archival-rpc.mainnet.fastnear.com",
    "https://archival-rpc.mainnet.near.org",
  ],
};

export const EXPLORER: Record<Network, string> = {
  testnet: "https://testnet.nearblocks.io",
  mainnet: "https://nearblocks.io",
};

async function rpc<T>(
  network: Network,
  method: string,
  params: unknown,
  url: string = RPC[network],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const body = (await res.json()) as {
      result?: T;
      error?: { cause?: { name?: string }; message: string };
    };
    if (body.error) throw new Error(`${method}: ${body.error.cause?.name ?? body.error.message}`);
    return body.result as T;
  }
}

/** Calls a view method and parses its JSON result. */
export async function view<T>(
  network: Network,
  contract: string,
  method: string,
  args: object = {},
): Promise<T> {
  const result = await rpc<{ result: number[]; error?: string }>(network, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (result.error) throw new Error(`${contract}.${method}: ${result.error}`);
  return JSON.parse(Buffer.from(result.result).toString()) as T;
}

export async function accountExists(network: Network, accountId: string): Promise<boolean> {
  try {
    await rpc(network, "query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return true;
  } catch (e) {
    if (String(e).includes("UNKNOWN_ACCOUNT")) return false;
    throw e;
  }
}

export type AccountInfo = {
  amount: string;
  code_hash: string;
  /** Set when the account runs a global contract (newer Sputnik DAOs do). */
  global_contract_hash?: string;
  storage_usage: number;
};

export async function viewAccount(network: Network, accountId: string): Promise<AccountInfo> {
  return rpc<AccountInfo>(network, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
}

export type AccessKey = { public_key: string; access_key: { permission: "FullAccess" | object } };

export async function accessKeys(network: Network, accountId: string): Promise<AccessKey[]> {
  const r = await rpc<{ keys: AccessKey[] }>(network, "query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  });
  return r.keys;
}

export type TxStatus = {
  status: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome: {
    outcome: {
      status: { SuccessValue?: string; Failure?: unknown };
      executor_id: string;
      logs: string[];
    };
  }[];
};

/** Looks a transaction up on the archival nodes: each node in turn, one retry each. */
export async function txStatus(network: Network, hash: string, sender: string): Promise<TxStatus> {
  const params = { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" };
  let last: unknown;
  for (const url of ARCHIVAL_RPC[network]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await rpc<TxStatus>(network, "tx", params, url);
      } catch (e) {
        last = e;
      }
    }
  }
  throw last;
}

/** A signing account from the CLI legacy keychain. Testnet setup scripts only. */
export function keychainAccount(network: Network, accountId: string): Account {
  const file = `${homedir()}/.near-credentials/${network}/${accountId}.json`;
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: KeyPairString };
  return new Account(accountId, new JsonRpcProvider({ url: RPC[network] }), private_key);
}

export type CallResult = { hash: string; ok: boolean; value: unknown; error?: string };

const TGAS = 1_000_000_000_000n;

/** Sends one function call and returns its hash and outcome without throwing on a panic. */
export async function call(
  signer: Account,
  contract: string,
  method: string,
  args: object,
  { gasTgas = 100, deposit = 0n }: { gasTgas?: number; deposit?: bigint } = {},
): Promise<CallResult> {
  const res = (await signer.signAndSendTransaction({
    receiverId: contract,
    actions: [actions.functionCall(method, args, BigInt(gasTgas) * TGAS, deposit)],
    waitUntil: "FINAL",
    throwOnFailure: false,
  })) as unknown as TxStatus & { transaction: { hash: string } };
  const hash = res.transaction.hash;
  const failure =
    res.receipts_outcome.map((r) => r.outcome.status.Failure).find(Boolean) ?? res.status.Failure;
  const raw = res.status.SuccessValue;
  let value: unknown = null;
  if (raw) {
    const text = Buffer.from(raw, "base64").toString();
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return failure
    ? { hash, ok: false, value, error: panicMessage(failure) }
    : { hash, ok: true, value };
}

/** "Smart contract panicked: payee_not_allowed" -> "payee_not_allowed". */
export function panicMessage(failure: unknown): string {
  const text = JSON.stringify(failure);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/);
  return m?.[1] ?? text;
}

export const NEAR = (n: number | string): bigint => {
  const [whole = "0", frac = ""] = String(n).split(".");
  return BigInt(whole) * 10n ** 24n + BigInt((frac + "0".repeat(24)).slice(0, 24));
};
