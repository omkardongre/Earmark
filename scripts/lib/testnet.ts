// Testnet setup helpers shared by scripts/testnet: create accounts, run DAO proposals.
// Keys live in the NEAR CLI legacy keychain (~/.near-credentials/testnet), never in the repo.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { actions, KeyPair } from "near-api-js";
import { accountExists, type CallResult, call, keychainAccount, NEAR, view } from "./near.ts";

const network = "testnet";

/** Creates `id` as a sub-account funded by `owner`, and stores its key in the keychain. */
export async function ensureAccount(owner: string, id: string, near: string) {
  if (await accountExists(network, id)) return;
  const kp = KeyPair.fromRandom("ed25519");
  await keychainAccount(network, owner).signAndSendTransaction({
    receiverId: id,
    actions: [
      actions.createAccount(),
      actions.transfer(NEAR(near)),
      actions.addFullAccessKey(kp.getPublicKey()),
    ],
    waitUntil: "FINAL",
  });
  writeFileSync(
    `${homedir()}/.near-credentials/${network}/${id}.json`,
    JSON.stringify({
      account_id: id,
      public_key: kp.getPublicKey().toString(),
      private_key: kp.toString(),
    }),
    { mode: 0o600 },
  );
  console.log(`created ${id}`);
}

/** Votes VoteApprove as each voter in turn until the proposal is approved. */
export async function voteUntilApproved(
  dao: string,
  id: number,
  voters: string[],
): Promise<CallResult> {
  const stored = await view<{ kind: object }>(network, dao, "get_proposal", { id });
  for (const voter of voters) {
    const voted = await call(
      keychainAccount(network, voter),
      dao,
      "act_proposal",
      { id, action: "VoteApprove", proposal: stored.kind },
      { gasTgas: 200 },
    );
    const after = await view<{ status: string }>(network, dao, "get_proposal", { id });
    if (after.status === "Approved") return voted;
    if (after.status !== "InProgress") throw new Error(`proposal ${id}: ${after.status}`);
  }
  throw new Error(`proposal ${id} not approved by ${voters.join(", ")}`);
}

/** `proposer` files a proposal (paying the DAO's bond); `voters` approve it. */
export async function daoDo(
  dao: string,
  proposer: string,
  voters: string[],
  description: string,
  kind: object,
): Promise<CallResult & { proposalId: number }> {
  const policy = await view<{ proposal_bond: string }>(network, dao, "get_policy");
  const added = await call(
    keychainAccount(network, proposer),
    dao,
    "add_proposal",
    { proposal: { description, kind } },
    { gasTgas: 50, deposit: BigInt(policy.proposal_bond) },
  );
  if (!added.ok) throw new Error(`add_proposal: ${added.error}`);
  const proposalId = Number(added.value);
  return { ...(await voteUntilApproved(dao, proposalId, voters)), proposalId };
}

/** A DAO FunctionCall proposal kind with one call. */
export function functionCallKind(
  receiver: string,
  method: string,
  args: object,
  deposit = "0",
  gas = "100000000000000",
) {
  return {
    FunctionCall: {
      receiver_id: receiver,
      actions: [
        {
          method_name: method,
          args: Buffer.from(JSON.stringify(args)).toString("base64"),
          deposit,
          gas,
        },
      ],
    },
  };
}
