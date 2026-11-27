import * as repo from "../repo/import-repo";
import { isGoneFromFullFeed } from "./outcome";

/**
 * D71 guard shared by the full source check and the window sweep: a job the
 * current source no longer carries is closed only when nothing still
 * carries it.
 *
 * - Another source keeps the job open when its row was seen within that
 *   source's own window (`cutoffFor`) or its last liveness check was `live`.
 * - Another row of the current source (one job, two external ids) keeps it
 *   open when it was listed in this run (`listedExternalIds`) or its last
 *   check was `live`, unless it is one of the rows being closed
 *   (`closingExternalIds`).
 *
 * Otherwise the rule is `isGoneFromFullFeed` with `now` as the run moment.
 */
export async function splitGoneEverywhere(
  jobIds: readonly string[],
  currentSourceId: string,
  now: Date,
  cutoffFor: (sourceId: string) => Date,
  rows: {
    listedExternalIds?: ReadonlySet<string>;
    closingExternalIds?: ReadonlySet<string>;
  } = {},
): Promise<{ gone: Set<string>; keptAlive: Set<string> }> {
  const gone = new Set<string>();
  const keptAlive = new Set<string>();
  const unique = [...new Set(jobIds)];
  if (!unique.length) return { gone, keptAlive };
  const listed = rows.listedExternalIds ?? new Set<string>();
  const closing = rows.closingExternalIds ?? new Set<string>();

  const byJob = new Map<
    string,
    { lastSeenAt: Date; currentSource: boolean }[]
  >();
  for (const row of await repo.sourceRowsOfJobs(unique)) {
    const currentSource = row.sourceId === currentSourceId;
    let lastSeenAt: Date;
    if (currentSource) {
      const aliveHere =
        listed.has(row.externalId) ||
        (row.lastCheckResult === "live" && !closing.has(row.externalId));
      // "Seen now" keeps the job; otherwise its real last sighting counts.
      lastSeenAt = aliveHere ? now : row.lastSeenAt;
    } else {
      const aliveElsewhere =
        row.lastCheckResult === "live" ||
        row.lastSeenAt.getTime() >= cutoffFor(row.sourceId).getTime();
      // Mapped to "now" (alive) or the epoch (lost), so the cutoff passed
      // to isGoneFromFullFeed below only tells the two apart.
      lastSeenAt = aliveElsewhere ? now : new Date(0);
    }
    byJob.set(row.jobId, [
      ...(byJob.get(row.jobId) ?? []),
      { lastSeenAt, currentSource },
    ]);
  }
  for (const jobId of unique) {
    (isGoneFromFullFeed(byJob.get(jobId) ?? [], now, now) ? gone : keptAlive).add(
      jobId,
    );
  }
  return { gone, keptAlive };
}
