"use client";

import type { ReactNode } from "react";
import { useWallet } from "./wallet";

/** Shows its children only to visitors who aren't signed in (the landing intro). */
export function SignedOut({ children }: { children: ReactNode }) {
  const { accountId } = useWallet();
  return accountId ? null : children;
}
