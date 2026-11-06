import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AccountButton } from "@/components/account-button";
import { NavLinks } from "@/components/nav-links";
import { ToastProvider } from "@/components/toast";
import { WalletProvider } from "@/components/wallet";
import { NETWORK } from "@/lib/config";
import { listBudgets } from "@/lib/near";
import "./globals.css";

export const metadata: Metadata = {
  title: "Earmark · Team budgets for DAOs",
  description:
    "Give each team a budget. Small payments go out at once, bigger ones need one approval, the rest go to a DAO vote.",
};

export const viewport: Viewport = { themeColor: "#4f46e5", width: "device-width", initialScale: 1 };

/** approver -> payments waiting in their budgets. Drives the Approvals tab and its badge. */
async function approverQueue(): Promise<Record<string, number>> {
  try {
    const out: Record<string, number> = {};
    for (const b of await listBudgets()) {
      if (b.closed) continue;
      for (const a of b.approvers) out[a] = (out[a] ?? 0) + b.pending_requests.length;
    }
    return out;
  } catch {
    return {};
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const queue = await approverQueue();
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans text-[15px] sm:text-base">
        <WalletProvider>
          <ToastProvider>
            <header className="sticky top-0 z-20 border-b border-line bg-white/90 backdrop-blur">
              <div className="mx-auto flex h-16 max-w-5xl items-center gap-6 px-4">
                <Link
                  href="/"
                  className="flex items-center gap-2.5 text-lg font-bold tracking-tight"
                >
                  <span className="grid size-8 place-items-center rounded-[9px] bg-gradient-to-br from-indigo-500 via-brand to-emerald-600 text-white shadow-[0_4px_12px_-4px_rgb(79_70_229/60%)]">
                    E
                  </span>
                  Earmark
                </Link>
                <NavLinks queue={queue} />
                <div className="ml-auto flex items-center gap-3">
                  {NETWORK === "testnet" && (
                    <span className="hidden rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 sm:inline">
                      Testnet
                    </span>
                  )}
                  <AccountButton />
                </div>
              </div>
            </header>
            <main className="mx-auto max-w-5xl px-4 pb-28 pt-8 sm:pb-16">{children}</main>
            <NavLinks queue={queue} mobile />
          </ToastProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
