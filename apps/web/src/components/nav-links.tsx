"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NETWORK } from "@/lib/config";
import { CHANGED, useWallet } from "./wallet";

/**
 * Top links on desktop; a bottom tab bar on phones (rendered outside the blurred header).
 * "Approvals" only shows for an approver, with a badge for the payments waiting.
 */
export function NavLinks({
  queue: initial,
  mobile = false,
}: {
  queue: Record<string, number>;
  mobile?: boolean;
}) {
  const path = usePathname();
  const { accountId } = useWallet();
  // The layout's count can stay stale after an approval (router.refresh doesn't always re-render
  // it), so the badge reloads its own count after each action.
  const [queue, setQueue] = useState(initial);
  useEffect(() => {
    const reload = async () => {
      try {
        const res = await fetch("/api/queue", { cache: "no-store" });
        if (res.ok) setQueue((await res.json()) as Record<string, number>);
      } catch {
        // Keep the last count; the next action or a reload catches up.
      }
    };
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, []);
  const waiting = accountId ? queue[accountId] : undefined;
  const links = [
    { href: "/", label: "Budgets" },
    ...(waiting !== undefined ? [{ href: "/approvals", label: "Approvals", badge: waiting }] : []),
    { href: "/people", label: "People" },
    { href: "/preview", label: "Replay" },
    // "Try it" is a testnet sandbox; the mainnet landing links to it instead.
    ...(accountId || NETWORK === "mainnet" ? [] : [{ href: "/try", label: "Try it" }]),
  ];
  return (
    <nav
      className={
        mobile
          ? "fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-line bg-white pb-[env(safe-area-inset-bottom)] sm:hidden"
          : "hidden gap-1 sm:flex"
      }
    >
      {links.map((l) => {
        const active =
          l.href === "/"
            ? path === "/" || path.startsWith("/budgets") || path.startsWith("/payments")
            : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 font-medium ${
              mobile ? "px-3 py-3.5 text-sm" : "rounded-full px-3.5 py-1.5 text-[15px]"
            } ${active ? `text-brand ${mobile ? "" : "bg-brand-soft"}` : "text-muted hover:text-ink"}`}
          >
            {l.label}
            {"badge" in l && l.badge ? (
              <span className="grid min-w-5 place-items-center rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-white">
                {l.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
