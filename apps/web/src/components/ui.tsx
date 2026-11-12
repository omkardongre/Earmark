import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { isWalletAddress, shortName } from "@/lib/format";

export type Tone = "green" | "amber" | "blue" | "gray" | "red" | "brand";

const tones: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
  gray: "bg-slate-100 text-slate-600 ring-slate-500/20",
  red: "bg-rose-50 text-rose-700 ring-rose-600/20",
  brand: "bg-brand-soft text-brand ring-brand/20",
};

export function Pill({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`rounded-2xl border border-line bg-white shadow-card print:shadow-none ${className}`}
    >
      {children}
    </div>
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

const base =
  "inline-flex h-11.5 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold transition-colors disabled:cursor-not-allowed";

export const variants = {
  primary:
    "bg-brand text-white shadow-[0_6px_16px_-8px_rgb(79_70_229/70%)] hover:bg-brand-strong disabled:bg-indigo-300 disabled:shadow-none",
  secondary:
    "bg-white text-ink ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger:
    "bg-white text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50 disabled:text-rose-300",
  ghost: "text-muted hover:bg-slate-100 hover:text-ink",
};

/**
 * `busy`: the action is waiting for the wallet. The button keeps its colour and shows a spinner
 * (a disabled button would grey out and look like every other one), and ignores clicks.
 */
export function Button({
  variant = "primary",
  className = "",
  busy = false,
  children,
  onClick,
  ...props
}: ButtonProps & { busy?: boolean }) {
  return (
    <button
      type="button"
      className={`${base} ${variants[variant]} ${busy ? "pointer-events-none" : ""} ${className}`}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onClick}
      {...props}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}
export function Spinner() {
  return (
    <span
      className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
      aria-hidden
    />
  );
}
/** A quiet action (a link-style button): secondary choices next to one main button. */
export function TextButton({
  tone = "muted",
  className = "",
  busy = false,
  children,
  onClick,
  ...props
}: ComponentProps<"button"> & { tone?: "muted" | "danger"; busy?: boolean }) {
  const color =
    tone === "danger"
      ? "text-rose-700 hover:bg-rose-50"
      : "text-muted hover:bg-slate-100 hover:text-ink";
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[15px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${color} ${busy ? "pointer-events-none" : ""} ${className}`}
      aria-busy={busy || undefined}
      onClick={busy ? undefined : onClick}
      {...props}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

/** A Next link styled as a button. */
export function ButtonLink({
  href,
  variant = "primary",
  className = "",
  onClick,
  children,
}: {
  href: string;
  variant?: keyof typeof variants;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const cls = `${base} ${variants[variant]} ${className}`;
  // Another site (near.com) opens in a new tab.
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" onClick={onClick} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} {...(onClick ? { onClick } : {})} className={cls}>
      {children}
    </Link>
  );
}

export function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`font-medium text-brand hover:underline ${className}`}
    >
      {children}
    </a>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-slate-300 bg-white/60 px-4 py-10 text-center text-muted">
      <p>{children}</p>
      {action}
    </div>
  );
}

/** A collapsed card for things most people don't need ("How it works", "People"). */
export function Disclosure({
  title,
  hint,
  open,
  children,
}: {
  title: string;
  hint?: ReactNode;
  /** Opens the panel; left out, the user's own open/close is kept. */
  open?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group rounded-2xl border border-line bg-white shadow-card">
      <summary className="flex items-center justify-between gap-3 px-5 py-4">
        <span className="font-semibold">{title}</span>
        <span className="flex items-center gap-2 text-sm text-muted">
          {hint}
          <span className="chev text-lg text-subtle" aria-hidden>
            ›
          </span>
        </span>
      </summary>
      <div className="border-t border-line">{children}</div>
    </details>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-200/70 ${className}`} />;
}

export function Avatar({ id, size = "sm" }: { id: string; size?: "sm" | "lg" }) {
  const name = id.split(".")[0] ?? id;
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full bg-slate-200 font-semibold uppercase text-slate-600 ${
        size === "lg" ? "size-12 text-lg" : "size-7 text-xs"
      }`}
      aria-hidden
    >
      {isWalletAddress(id) ? (
        <WalletIcon className={size === "lg" ? "size-6" : "size-4"} />
      ) : (
        name.slice(0, 1)
      )}
    </span>
  );
}

/** A wallet (MetaMask and others): their `0x…` address has no name to take a letter from. */
function WalletIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <title>Wallet</title>
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      <path d="M21 12V9a2 2 0 0 0-2-2H5a2 2 0 0 1 0-4" />
      <path d="M21 12h-4a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  );
}

export function Person({ id }: { id: string }) {
  const name = shortName(id);
  return (
    <Link
      href={`/people/${id}`}
      title={id}
      className="inline-flex items-center gap-2 whitespace-nowrap font-medium hover:underline"
    >
      <Avatar id={id} />
      {name.length > 20 ? `${name.slice(0, 8)}…` : name}
    </Link>
  );
}
