import { RulePreview } from "@/components/rule-preview";

export const metadata = { title: "Replay a DAO · Earmark" };

export default function PreviewPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Replay a DAO’s history</h1>
        <p className="max-w-2xl text-muted">
          See how your DAO’s past payouts would be handled with two limits of your choice.
        </p>
      </div>
      <RulePreview defaultDao="nearweek-news-contribution.sputnik-dao.near" />
    </div>
  );
}
