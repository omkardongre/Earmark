"use client";

import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { CONTRACT, NETWORK } from "@/lib/config";
import { errorMessage } from "@/lib/format";

type CallOptions = { gasTgas?: number; deposit?: string; receiverId?: string };
type CallResult = { ok: true; hash: string; value: unknown } | { ok: false; error: string };

type Wallet = {
  accountId: string | null;
  ready: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  call: (method: string, args: object, opts?: CallOptions) => Promise<CallResult>;
};

const WalletContext = createContext<Wallet | null>(null);

export function useWallet(): Wallet {
  const w = useContext(WalletContext);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}

type Outcome = {
  transaction: { hash: string };
  status: { SuccessValue?: string; Failure?: unknown } | string;
  receipts_outcome?: { outcome: { status: { Failure?: unknown } } }[];
};

function readOutcome(o: Outcome): CallResult {
  const failure =
    (typeof o.status === "object" ? o.status.Failure : undefined) ??
    o.receipts_outcome?.map((r) => r.outcome.status.Failure).find(Boolean);
  if (failure) return { ok: false, error: errorMessage(JSON.stringify(failure)) };
  const raw = typeof o.status === "object" ? o.status.SuccessValue : undefined;
  let value: unknown = null;
  if (raw) {
    try {
      value = JSON.parse(atob(raw));
    } catch {
      value = atob(raw);
    }
  }
  return { ok: true, hash: o.transaction.hash, value };
}

/** Fired after a successful transaction; client lists (activity) reload their first page. */
export const CHANGED = "earmark:changed";

/**
 * Reloads the server data now and again a little later. The RPC node and the history indexer can
 * lag a few seconds behind the transaction, and `router.refresh()` alone has been unreliable on
 * Next 16 (vercel/next.js#99028), so screens also update their own state after an action.
 */
function afterChange(refresh: () => void) {
  for (const ms of [0, 2500, 7000]) {
    setTimeout(() => {
      refresh();
      window.dispatchEvent(new Event(CHANGED));
    }, ms);
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const connector = useRef<NearConnector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { NearConnector } = await import("@hot-labs/near-connect");
      if (cancelled) return;
      const c = new NearConnector({
        network: NETWORK,
        features: { [NETWORK]: true, signAndSendTransaction: true },
        // DAO leads and approvers sign with a NEAR wallet; EVM wallets and the CLI only add noise.
        excludedWallets: ["ethereum-wallets", "near-cli"],
      });
      connector.current = c;
      c.on("wallet:signIn", (t) => setAccountId(t.accounts[0]?.accountId ?? null));
      c.on("wallet:signOut", () => setAccountId(null));
      try {
        const { accounts } = await c.getConnectedWallet();
        setAccountId(accounts[0]?.accountId ?? null);
      } catch {
        // Not connected yet.
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    await connector.current?.connect();
  }, []);

  const disconnect = useCallback(async () => {
    await connector.current?.disconnect();
    setAccountId(null);
  }, []);

  const call = useCallback(
    async (method: string, args: object, opts: CallOptions = {}): Promise<CallResult> => {
      const c = connector.current;
      if (!c || !accountId) return { ok: false, error: "Connect your wallet first." };
      let wallet: NearWalletBase;
      try {
        wallet = await c.wallet();
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
      try {
        const outcome = (await wallet.signAndSendTransaction({
          receiverId: opts.receiverId ?? CONTRACT,
          actions: [
            {
              type: "FunctionCall",
              params: {
                methodName: method,
                args,
                gas: String(BigInt(opts.gasTgas ?? 100) * 1_000_000_000_000n),
                deposit: opts.deposit ?? "0",
              },
            },
          ],
        })) as unknown as Outcome;
        const result = readOutcome(outcome);
        // A failed receipt can still change state (a payment marked failed), so reload either way.
        afterChange(router.refresh);
        return result;
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
    },
    [accountId, router],
  );

  return (
    <WalletContext.Provider value={{ accountId, ready, connect, disconnect, call }}>
      {children}
    </WalletContext.Provider>
  );
}
