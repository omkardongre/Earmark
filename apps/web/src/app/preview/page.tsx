import { RulePreview } from "@/components/rule-preview";
import { display } from "@/lib/fonts";

export const metadata = { title: "Replay a DAO · Earmark" };

export default function PreviewPage() {
  return (
    <div className={`${display.className} relative space-y-6`}>
      <div
        aria-hidden
        className="dot-grid pointer-events-none absolute -inset-x-24 -top-16 -z-10 h-[24rem]"
      />
      <div className="rise max-w-4xl space-y-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-sm font-medium text-muted ring-1 ring-line backdrop-blur">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          Replay a DAO’s history
        </span>
        <h1 className="text-4xl font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[2.75rem]">
          How many votes would <span className="text-gradient">your DAO save?</span>
        </h1>
        <p className="text-lg text-muted">
          Pick two limits. We sort every past payout and count how many still need a council vote.
        </p>
      </div>
      <RulePreview defaultDao="nearweek-news-contribution.sputnik-dao.near" />
    </div>
  );
}
