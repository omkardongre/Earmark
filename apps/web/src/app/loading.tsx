import { Card, Skeleton } from "@/components/ui";

/** Shown at once on navigation while the page reads the chain. */
export default function Loading() {
  return (
    <div className="space-y-8" role="status" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-9 w-56" />
      <Card className="space-y-4 p-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-4 w-64" />
      </Card>
      <Card className="divide-y divide-line">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-5 py-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </Card>
    </div>
  );
}
