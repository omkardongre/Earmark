"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CONTRACT, NETWORK } from "@/lib/config";
import {
  canContractEscalate,
  canPropose,
  createEnvelopeKind,
  type DaoPolicy,
  escalationFix,
  ftBalance,
  ftRegistered,
  getPolicy,
  maxBig,
  suggestedApprovers,
  validAccountId,
} from "@/lib/dao";
import { money, shortName } from "@/lib/format";
import { freeNear, getConfig, getToken } from "@/lib/near";
import type { TokenMeta } from "@/lib/types";
import {
  type BudgetForm,
  checkBudget,
  type FormErrors,
  input,
  PERIODS,
  SetupForm,
} from "./setup-form";
import { SetupFund } from "./setup-fund";
import { nearAmount, type PlannedProposal, SetupReview } from "./setup-review";
import { Button, Card } from "./ui";
import { useWallet } from "./wallet";

/** What storing one proposal costs a DAO with no bond (Sputnik charges its own balance). */
const PROPOSAL_STORAGE = 10n ** 22n;

type Dao = {
  id: string;
  policy: DaoPolicy;
  tokens: Record<string, TokenMeta>;
  /** Set when this Earmark deployment can't serve the DAO. */
  wrongDao: string | null;
  approverSource: string | null;
};

const blank = (token: string, approvers: string[]): BudgetForm => ({
  name: "",
  token,
  amount: "",
  period: "2592000",
  leads: [{ key: 0, account: "", auto: "10" }],
  oneApproval: "50",
  approvers,
  payees: [],
});

export function SetupFlow({
  initialDao,
  resume,
}: {
  initialDao: string;
  resume: { proposal: number; amount: string | null } | null;
}) {
  const router = useRouter();
  const { accountId } = useWallet();
  const [daoInput, setDaoInput] = useState(initialDao);
  const [dao, setDao] = useState<Dao | null>(null);
  const [loading, setLoading] = useState(false);
  const [daoError, setDaoError] = useState<string | null>(null);
  const [form, setForm] = useState<BudgetForm | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  /** Stops filing: the vote would pass and then fail on chain. */
  const [stop, setStop] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState<{
    plan: PlannedProposal[];
    later: string;
    amount: string;
  } | null>(null);
  const [sentCreate, setSentCreate] = useState<number | null>(null);

  async function loadDao(id: string) {
    const daoId = id.trim().toLowerCase();
    if (!validAccountId(daoId)) {
      setDaoError("Enter the DAO's account, like mydao.sputnik-dao.near.");
      return;
    }
    setLoading(true);
    setDaoError(null);
    try {
      const [policy, config] = await Promise.all([getPolicy(daoId), getConfig()]);
      const metas = await Promise.all(config.token_ids.map((t) => getToken(t)));
      const tokens = Object.fromEntries(config.token_ids.map((t, i) => [t, metas[i] as TokenMeta]));
      const approvers = suggestedApprovers(policy);
      setDao({
        id: daoId,
        policy,
        tokens,
        wrongDao: config.dao_id === daoId ? null : config.dao_id,
        approverSource: approvers.role,
      });
      setForm(blank(config.token_ids[0] ?? "", approvers.members.slice(0, 10)));
      setErrors({});
      setReview(null);
    } catch {
      setDao(null);
      setDaoError(`Couldn't read a DAO policy from ${daoId}. Check the account name.`);
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load the DAO when the form opens.
  useEffect(() => {
    if (initialDao && !resume && !dao) loadDao(initialDao);
  }, [resume === null]);

  if (resume && sentCreate === null) {
    return (
      <div className="space-y-4">
        <SetupFund dao={initialDao} proposalId={resume.proposal} amount={resume.amount} />
        <Button variant="ghost" onClick={() => router.replace("/setup")}>
          Set up another budget
        </Button>
      </div>
    );
  }

  const escalation = dao ? canContractEscalate(dao.policy, CONTRACT) : null;
  const fix = dao && escalation && !escalation.ok ? escalationFix(dao.policy, CONTRACT) : null;
  const canFile = dao && accountId ? canPropose(dao.policy, accountId, "call") : null;

  async function toReview() {
    if (!dao || !form) return;
    const meta = dao.tokens[form.token];
    if (!meta) return;
    setChecking(true);
    const { errors: errs, envelope } = await checkBudget(form, meta);
    setErrors(errs);
    if (!envelope) {
      setChecking(false);
      return;
    }
    // Not blocking: the funding vote runs later, and payees can register with the token later.
    const notes: string[] = [];
    const kind = createEnvelopeKind(CONTRACT, envelope);
    const storageDeposit = BigInt(kind.FunctionCall.actions[0]?.deposit ?? "0");
    const [daoHolds, contractReady, payeeReady, daoFree] = await Promise.all([
      ftBalance(form.token, dao.id).catch(() => null),
      ftRegistered(form.token, CONTRACT).catch(() => true),
      Promise.all(envelope.payees.map((p) => ftRegistered(form.token, p).catch(() => true))),
      freeNear(dao.id).catch(() => null),
    ]);
    // The DAO pays the budget's storage when the vote runs, and with no bond it also pays for
    // storing each proposal (~0.01 NEAR). A new Trezu treasury starts with ~0.07 NEAR free.
    const daoNeeds = storageDeposit + PROPOSAL_STORAGE * 3n;
    setStop(
      daoFree !== null && daoFree < daoNeeds
        ? `Add ${nearAmount((daoNeeds - daoFree).toString(), "up")} to ${dao.id} first. The budget vote sends ${nearAmount(storageDeposit.toString())} from it for storage, and the DAO has ${nearAmount(daoFree.toString())} free.`
        : null,
    );
    if (daoHolds !== null && BigInt(daoHolds) < BigInt(envelope.period_cap))
      notes.push(
        `The DAO holds ${money(daoHolds, meta)}. Funding needs ${money(envelope.period_cap, meta)} when it runs.`,
      );
    if (!contractReady) notes.push(`Earmark isn't registered with ${meta.symbol} yet.`);
    const unregistered = envelope.payees.filter((_, i) => !payeeReady[i]);
    if (unregistered.length)
      notes.push(
        `${unregistered.map(shortName).join(", ")} can't receive ${meta.symbol} until they register with the token.`,
      );
    setWarnings(notes);

    const period = PERIODS.find((p) => p.secs === envelope.period_secs)?.label ?? "period";
    const m = (v: string) => money(v, meta);
    // Names for people; the full accounts are in Details.
    const names = (ids: string[]) => ids.map(shortName).join(", ");
    const leads = envelope.spenders.map(
      (s) => `${shortName(s.account_id)}, ${m(s.auto_limit)} at once`,
    );
    const plan: PlannedProposal[] = [];
    if (fix) {
      // The role and the contract account are in Details; people read what it does.
      plan.push({
        key: "role",
        title: "Let Earmark send big payments to a vote",
        lines: [
          `Payments above ${m(envelope.one_approver_limit)} go to your council as a DAO vote. Earmark can ask, but never vote.`,
        ],
        label: fix.label,
        proposal: {
          description: `* Title: Add Earmark as ${fix.role} <br>* Notes: ${CONTRACT} files payments above the budget's approval limit as DAO votes`,
          kind: fix.kind,
        },
      });
    }
    // A raise line only when approvers could raise someone above today's limit.
    const raisable = envelope.spenders.some(
      (s) => BigInt(s.auto_limit) < BigInt(envelope.raise_ceiling),
    );
    const [first] = envelope.spenders;
    const whoPays =
      envelope.spenders.length === 1 && first
        ? `${shortName(first.account_id)} pays up to ${m(first.auto_limit)} at once`
        : `${envelope.spenders.length} leads pay up to ${m(maxBig(...envelope.spenders.map((s) => BigInt(s.auto_limit))).toString())} at once`;
    plan.push({
      key: "create",
      title: `Create the budget “${envelope.name}”`,
      lines: [
        `Leads: ${leads.join("; ")}.`,
        `Up to ${m(envelope.one_approver_limit)} needs one approval from ${names(envelope.approvers)}; more goes to a DAO vote.`,
        `Pays only ${names(envelope.payees)}.`,
        `Up to ${m(envelope.period_cap)} per ${period}.${raisable ? ` Approvers can raise a lead to ${m(envelope.raise_ceiling)} after a waiting period.` : ""}`,
      ],
      label: "call",
      proposal: {
        description: `* Title: Create Earmark budget "${envelope.name}" <br>* Notes: ${whoPays}; up to ${m(envelope.one_approver_limit)} with one approval; above that, a DAO vote`,
        kind,
      },
      decoded: { envelope },
    });
    setReview({
      plan,
      amount: envelope.period_cap,
      later: `Fund it with ${m(envelope.period_cap)}, after the vote passes.`,
    });
    setChecking(false);
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            loadDao(daoInput);
          }}
        >
          <input
            className={input}
            aria-label="DAO account"
            placeholder={
              NETWORK === "mainnet" ? "mydao.sputnik-dao.near" : "mydao.sputnikv2.testnet"
            }
            value={daoInput}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setDaoInput(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={loading}>
            {loading ? "Reading…" : "Continue"}
          </Button>
        </form>
        {daoError && <p className="text-sm text-rose-700">{daoError}</p>}
        {dao && (
          <div className="space-y-2 text-sm">
            {dao.wrongDao ? (
              <p className="text-rose-700">
                This Earmark app works with {dao.wrongDao}. Another DAO needs its own Earmark
                contract.
              </p>
            ) : (
              <>
                {/* First budget in this DAO: the plan includes the vote that lets Earmark escalate. */}
                <p className={escalation?.ok ? "text-emerald-700" : "text-muted"}>
                  {escalation?.ok
                    ? "✓ Earmark can send big payments to a DAO vote."
                    : "The plan also lets Earmark send big payments to a DAO vote."}
                </p>
                {canFile === false && (
                  <p className="text-amber-800">
                    {accountId} can’t file proposals here. You can fill the form; someone with a
                    proposing role submits it.
                  </p>
                )}
                {BigInt(dao.policy.proposal_bond) > 0n && (
                  <p className="text-muted">
                    Proposal bond: {nearAmount(dao.policy.proposal_bond)} each.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      {dao && !dao.wrongDao && form && !review && (
        <Card className="space-y-6 p-5">
          <SetupForm
            value={form}
            onChange={setForm}
            errors={errors}
            tokens={dao.tokens}
            approverRole={dao.approverSource}
          />
          <Button onClick={toReview} disabled={checking} className="w-full sm:w-auto">
            {checking ? "Checking accounts…" : "Review proposals"}
          </Button>
        </Card>
      )}

      {dao && review && (
        <>
          {warnings.length > 0 && (
            <ul className="space-y-1 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <SetupReview
            dao={dao.id}
            policy={dao.policy}
            plan={review.plan}
            later={review.later}
            stop={stop}
            onBack={() => setReview(null)}
            onSent={(sent) => {
              const id = sent.create?.id;
              if (id === undefined) return;
              setSentCreate(id);
              // A link that keeps the place: funding is filed here after the vote.
              const q = new URLSearchParams({
                dao: dao.id,
                proposal: String(id),
                amount: review.amount,
              });
              router.replace(`/setup?${q}`, { scroll: false });
            }}
          />
          {sentCreate !== null && (
            <SetupFund dao={dao.id} proposalId={sentCreate} amount={review.amount} />
          )}
        </>
      )}
    </div>
  );
}
