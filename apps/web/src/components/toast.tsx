"use client";

import Link from "next/link";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { txUrl } from "@/lib/config";

/** `href` opens a page in the app (the payment); otherwise `tx` opens the transaction. */
/** `fee`: Earmark paid the network fee (a relayed call), said in a small second line. */
type Toast = { ok: boolean; text: string; tx?: string; href?: string; fee?: boolean };

const ToastContext = createContext<(t: Toast) => void>(() => {});

/** Short confirmation after an action ("Approved and paid"), with a link to what changed. */
export const useToast = () => useContext(ToastContext);

/** Long enough to read and reach "View" (about 8 s); errors stay until closed. */
const OK_MS = 8000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(Toast & { id: number }) | null>(null);
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((t: Toast) => {
    setHeld(false);
    setToast({ ...t, id: Date.now() });
  }, []);

  // Hovering or focusing the toast pauses the timer, so the link never slips away mid-click.
  useEffect(() => {
    clearTimeout(timer.current);
    if (toast?.ok && !held) timer.current = setTimeout(() => setToast(null), OK_MS);
    return () => clearTimeout(timer.current);
  }, [toast, held]);

  const link = "shrink-0 font-semibold text-indigo-200 hover:underline";
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 sm:bottom-6"
      >
        {toast && (
          <div
            key={toast.id}
            role="status"
            onMouseEnter={() => setHeld(true)}
            onMouseLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={() => setHeld(false)}
            className={`toast-in pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl px-4 py-3 text-[15px] text-white shadow-lg ${
              toast.ok ? "bg-slate-900" : "bg-rose-700"
            }`}
          >
            <span aria-hidden>{toast.ok ? "✓" : "!"}</span>
            <span>
              {toast.text}
              {toast.fee && (
                <span className="block text-sm text-white/70">Network fee paid by Earmark</span>
              )}
            </span>
            {toast.href ? (
              <Link href={toast.href} className={link} onClick={() => setToast(null)}>
                View
              </Link>
            ) : toast.tx ? (
              <a href={txUrl(toast.tx)} target="_blank" rel="noreferrer" className={link}>
                View
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => setToast(null)}
              className="shrink-0 text-white/70 hover:text-white"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
