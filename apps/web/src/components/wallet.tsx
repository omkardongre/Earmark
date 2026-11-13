"use client";

import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { useRouter } from "next/navigation";
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { CONTRACT, NETWORK } from "@/lib/config";
import { errorMessage } from "@/lib/format";
import { Button } from "./ui";

type CallOptions = { gasTgas?: number; deposit?: string; receiverId?: string };
/** `sponsored`: Earmark's relayer paid the network fee for this call (feature 8). */
type CallResult =
  | { ok: true; hash: string; value: unknown; sponsored?: boolean }
  | { ok: false; error: string };

type Wallet = {
  accountId: string | null;
  ready: boolean;
  /** Earmark pays the network fee for this wallet's calls to our contract (feature 8). */
  sponsored: boolean;
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

type ReceiptStatus = { Failure?: unknown; SuccessValue?: string; SuccessReceiptId?: string };
type Outcome = {
  transaction: { hash: string };
  status: { SuccessValue?: string; Failure?: unknown } | string;
  receipts_outcome?: { id: string; outcome: { executor_id: string; status: ReceiptStatus } }[];
};

/**
 * A relayed call's own status is the delegate's (empty); the contract's answer is in its receipts.
 * Follows the first receipt on our contract the way NEAR resolves a transaction's final value.
 */
function innerValue(o: Outcome): string | undefined {
  const receipts = o.receipts_outcome ?? [];
  let r = receipts.find((x) => x.outcome.executor_id === CONTRACT);
  for (let hops = 0; r && hops < 20; hops++) {
    const next = r.outcome.status.SuccessReceiptId;
    if (!next) return r.outcome.status.SuccessValue;
    r = receipts.find((x) => x.id === next);
  }
  return undefined;
}

function readOutcome(o: Outcome, relayed = false): CallResult {
  const failure =
    (typeof o.status === "object" ? o.status.Failure : undefined) ??
    o.receipts_outcome?.map((r) => r.outcome.status.Failure).find(Boolean);
  if (failure) return { ok: false, error: errorMessage(JSON.stringify(failure)) };
  const raw = relayed
    ? innerValue(o)
    : typeof o.status === "object"
      ? o.status.SuccessValue
      : undefined;
  let value: unknown = null;
  if (raw) {
    try {
      value = JSON.parse(atob(raw));
    } catch {
      value = atob(raw);
    }
  }
  return { ok: true, hash: o.transaction.hash, value, sponsored: relayed };
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

type Relayed =
  | { kind: "done"; result: CallResult }
  | { kind: "stop"; result: CallResult }
  | { kind: "fallback"; reason: string };

/** Signs a delegate action in the wallet and has Earmark's relayer send it (docs/05 §4.3). */
async function relayCall(
  wallet: NearWalletBase,
  method: string,
  args: object,
  opts: CallOptions,
): Promise<Relayed> {
  let signed: string | undefined;
  try {
    const r = await wallet.signDelegateActions({
      delegateActions: [{ receiverId: CONTRACT, actions: [action(method, args, opts)] }],
    });
    signed = r.signedDelegateActions[0];
  } catch (e) {
    if (declined(e)) return { kind: "stop", result: { ok: false, error: errorMessage(e) } };
    return { kind: "fallback", reason: "Your wallet couldn’t sign it for Earmark to send." };
  }
  if (!signed) return { kind: "fallback", reason: "Your wallet returned nothing to send." };
  let res: Response;
  try {
    res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedDelegate: signed }),
    });
  } catch {
    return { kind: "fallback", reason: "Earmark’s server didn’t answer." };
  }
  const body = (await res.json().catch(() => ({}))) as {
    outcome?: Outcome;
    error?: string;
    reason?: string;
  };
  if (res.ok && body.outcome) return { kind: "done", result: readOutcome(body.outcome, true) };
  // Sent, but no answer: it may have gone through. Reload, and don't send it a second way.
  if (body.reason === "rpc") {
    return { kind: "stop", result: { ok: false, error: body.error ?? "No answer." } };
  }
  return { kind: "fallback", reason: body.error ?? "Earmark couldn’t send it." };
}

/** The wallet said no (closed, cancelled, rejected): nothing to fall back to. */
const declined = (e: unknown) => /cancel|reject|denied|closed|abort/i.test(errorMessage(e));

const action = (method: string, args: object, opts: CallOptions) => ({
  type: "FunctionCall" as const,
  params: {
    methodName: method,
    args,
    gas: String(BigInt(opts.gasTgas ?? 100) * 1_000_000_000_000n),
    deposit: opts.deposit ?? "0",
  },
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const connector = useRef<NearConnector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Fees paid by Earmark: the server relays, and the connected wallet signs delegate actions.
  const [relayOn, setRelayOn] = useState(false);
  const [delegates, setDelegates] = useState(false);
  const sponsored = relayOn && delegates;
  const feePrompt = useRef<HTMLDialogElement>(null);
  const feeAnswer = useRef<((pay: boolean) => void) | null>(null);
  const [feeReason, setFeeReason] = useState("");
  // Signing out or switching accounts goes home and drops every screen's state, so nothing the
  // last account saw or typed carries over. Signing in from signed out stays on the page.
  const previous = useRef<string | null>(null);
  const [scope, setScope] = useState(0);
  useEffect(() => {
    const before = previous.current;
    previous.current = accountId;
    if (before && before !== accountId) {
      setScope((s) => s + 1);
      router.replace("/");
    }
  }, [accountId, router]);

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
    fetch("/api/relay", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled: boolean }>) : null))
      .then((r) => !cancelled && setRelayOn(!!r?.enabled))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!accountId) return setDelegates(false);
    let cancelled = false;
    connector.current
      ?.wallet()
      .then((w) => !cancelled && setDelegates(!!w.manifest.features.signDelegateActions))
      .catch(() => !cancelled && setDelegates(false));
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  /** Asks whether to pay the fee from the wallet when Earmark can't; never switches silently. */
  const askToPay = useCallback((reason: string) => {
    setFeeReason(reason);
    feePrompt.current?.showModal();
    return new Promise<boolean>((resolve) => {
      feeAnswer.current = resolve;
    });
  }, []);
  const answerFee = (pay: boolean) => {
    feePrompt.current?.close();
    feeAnswer.current?.(pay);
    feeAnswer.current = null;
  };

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
      const receiverId = opts.receiverId ?? CONTRACT;
      const canSponsor = sponsored && receiverId === CONTRACT && (opts.deposit ?? "0") === "0";
      if (canSponsor) {
        const relayed = await relayCall(wallet, method, args, opts);
        if (relayed.kind === "done") {
          afterChange(router.refresh);
          return relayed.result;
        }
        if (relayed.kind === "stop") {
          afterChange(router.refresh);
          return relayed.result;
        }
        // Earmark can't cover it (cap, outage, unsupported): the member decides.
        if (!(await askToPay(relayed.reason))) return { ok: false, error: "Not sent." };
      }
      try {
        const outcome = (await wallet.signAndSendTransaction({
          receiverId,
          actions: [action(method, args, opts)],
        })) as unknown as Outcome;
        const result = readOutcome(outcome);
        // A failed receipt can still change state (a payment marked failed), so reload either way.
        afterChange(router.refresh);
        return result;
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
    },
    [accountId, router, sponsored, askToPay],
  );

  return (
    <WalletContext.Provider value={{ accountId, ready, sponsored, connect, disconnect, call }}>
      <Fragment key={scope}>{children}</Fragment>
      <dialog
        ref={feePrompt}
        onCancel={() => answerFee(false)}
        className="m-auto w-[min(92vw,26rem)] rounded-2xl p-6 shadow-xl backdrop:bg-slate-900/40"
      >
        <p className="font-semibold">Earmark can’t cover this fee right now</p>
        <p className="mt-1 text-sm text-muted">{feeReason}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => answerFee(false)}>
            Cancel
          </Button>
          <Button onClick={() => answerFee(true)}>Pay the fee myself</Button>
        </div>
      </dialog>
    </WalletContext.Provider>
  );
}

/**
 * "No network fee for you" under a main action, when the relayer pays it (feature 8). While the
 * wallet asks, it says what to expect: some wallets title the request "Sign Delegate Action".
 */
export function FeeNote({
  className = "",
  signing = false,
}: {
  className?: string;
  signing?: boolean;
}) {
  const { sponsored, accountId } = useWallet();
  if (!sponsored || !accountId) return null;
  return (
    <p className={`text-center text-sm text-muted ${className}`} aria-live="polite">
      {signing ? "Sign in your wallet. Earmark pays the network fee." : "No network fee for you"}
    </p>
  );
}
