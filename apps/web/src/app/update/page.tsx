import type { Metadata } from "next";
import { CodeUpdate } from "@/components/code-update";
import { DaoLock } from "@/components/dao-lock";

export const metadata: Metadata = { title: "Update the contract · Earmark" };

/** DAO-voted code update of the Earmark contract. Not in the nav; linked when an update is due. */
export default function UpdatePage() {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Update the contract</h1>
        <p className="text-lg text-muted">Only your DAO can change Earmark’s code, by vote.</p>
      </div>
      <CodeUpdate />
      <DaoLock />
    </div>
  );
}
