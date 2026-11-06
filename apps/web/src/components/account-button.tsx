"use client";

import { useEffect, useId, useRef, useState } from "react";
import { accountUrl } from "@/lib/config";
import { shortName } from "@/lib/format";
import { Avatar, Button } from "./ui";
import { useWallet } from "./wallet";

/**
 * Signed out: "Sign in". Signed in: the name opens a small panel with the full account, Copy,
 * the explorer link and Sign out (disclosure pattern: a button with aria-expanded; Escape or a
 * click outside closes it).
 */
export function AccountButton() {
  const { accountId, ready, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!ready) return <div className="h-10 w-28 animate-pulse rounded-xl bg-slate-100" />;
  if (!accountId) return <Button onClick={connect}>Sign in</Button>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(accountId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the account is shown in full, so it can still be selected.
    }
  };

  const item =
    "flex w-full items-center rounded-lg px-3 py-2 text-left text-[15px] font-medium hover:bg-slate-100";
  return (
    <div ref={box} className="relative">
      <Button
        ref={button}
        variant="secondary"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
        {shortName(accountId)}
        <span className="text-muted" aria-hidden>
          ▾
        </span>
      </Button>
      <div
        id={panel}
        hidden={!open}
        className="absolute right-0 top-full z-30 mt-2 w-72 rounded-2xl border border-line bg-white p-2 shadow-lg"
      >
        <div className="flex items-center gap-3 px-3 py-2.5">
          <Avatar id={accountId} />
          <div className="min-w-0">
            <p className="font-semibold">{shortName(accountId)}</p>
            <p className="break-all text-sm text-muted">{accountId}</p>
          </div>
        </div>
        <div className="my-1 border-t border-line" />
        <button type="button" className={item} onClick={copy}>
          {copied ? "Copied ✓" : "Copy account"}
        </button>
        <a href={accountUrl(accountId)} target="_blank" rel="noreferrer" className={item}>
          View on explorer
        </a>
        <button
          type="button"
          className={`${item} text-rose-700 hover:bg-rose-50`}
          onClick={async () => {
            setOpen(false);
            await disconnect();
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
