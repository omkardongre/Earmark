"use client";

import { NEAR_COM } from "@/lib/intents";
import { ButtonLink } from "./ui";
import { useWallet } from "./wallet";

/**
 * "Withdraw on near.com", for the payee only. They open the payment link signed out (a MetaMask
 * user has no NEAR wallet here), so it shows to anyone not signed in, and hides for the team.
 */
export function WithdrawLink({ payee }: { payee: string }) {
  const { accountId } = useWallet();
  if (accountId && accountId !== payee) return null;
  return (
    <ButtonLink href={NEAR_COM} variant="secondary" className="print:hidden">
      Withdraw on near.com
    </ButtonLink>
  );
}
