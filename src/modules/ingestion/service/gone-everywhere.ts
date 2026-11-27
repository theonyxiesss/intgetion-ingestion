import * as repo from "../repo/import-repo";
import { isGoneFromFullFeed } from "./outcome";

/**
 * D71 guard shared by the full source check and the window sweep: a job the
 * current source no longer carries is closed only when no other source
 * still carries it. Another source keeps the job open when its row was seen
 * within that source's own window (`cutoffFor`) or its last liveness check
 * was `live`. Otherwise the rule is `isGoneFromFullFeed` with `now` as the
 * run moment.
 */
export async function splitGoneEverywhere(
  jobIds: readonly string[],
  currentSourceId: string,
  now: Date,
  cutoffFor: (sourceId: string) => Date,
): Promise<{ gone: Set<string>; keptAlive: Set<string> }> {
  const gone = new Set<string>();
  const keptAlive = new Set<string>();
  const unique = [...new Set(jobIds)];
  if (!unique.length) return { gone, keptAlive };

  const byJob = new Map<
    string,
    { lastSeenAt: Date; currentSource: boolean }[]
  >();
  for (const row of await repo.sourceRowsOfJobs(unique)) {
    const currentSource = row.sourceId === currentSourceId;
    // Another source's row counts as "seen now" when it was seen within its
    // own window or its last check found the job live; else it lost it.
    const elsewhereAlive =
      !currentSource &&
      (row.lastCheckResult === "live" ||
        row.lastSeenAt.getTime() >= cutoffFor(row.sourceId).getTime());
    const lastSeenAt = currentSource
      ? row.lastSeenAt
      : elsewhereAlive
        ? now
        : new Date(0);
    byJob.set(row.jobId, [
      ...(byJob.get(row.jobId) ?? []),
      { lastSeenAt, currentSource },
    ]);
  }
  for (const jobId of unique) {
    // Other rows were mapped to "now" (alive) or the epoch (lost), so the
    // cutoff below only tells the two apart.
    (isGoneFromFullFeed(byJob.get(jobId) ?? [], now, now) ? gone : keptAlive).add(
      jobId,
    );
  }
  return { gone, keptAlive };
}
