import { expireImportedJobs } from "../../../platform";
import { hours, type LiveSource } from "../adapters/live";
import * as repo from "../repo/import-repo";
import { splitGoneEverywhere } from "./gone-everywhere";
import { LIVE_SOURCES } from "./ingest-fixtures";

/** A full source is checked again when nothing touched it this long. */
export const FULL_CHECK_MAX_AGE_MS = hours(20);

export type FullSourceCheckReport = {
  checked: number;
  /** Jobs closed, the length of `closedJobIds`. */
  closed: number;
  /** Job ids passed to expireImportedJobs. */
  closedJobIds: string[];
  skipped: number;
  failed: number;
};

/**
 * Daily check of "full" company boards: a published job missing from a
 * successfully downloaded, non-empty list is closed at the source. A failed
 * or empty list closes nothing. It does not save or update job content; it
 * only changes the status of closed jobs through expireImportedJobs. Neither
 * import_runs nor import_sources are written, so the import queue is intact.
 */
export async function runFullSourceChecks(
  input: {
    now?: Date;
    sources?: readonly LiveSource[];
    fetchImpl?: typeof fetch;
    maxAgeMs?: number;
  } = {},
): Promise<FullSourceCheckReport> {
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? FULL_CHECK_MAX_AGE_MS;
  const since = new Date(now.getTime() - maxAgeMs);
  const report: FullSourceCheckReport = {
    checked: 0,
    closed: 0,
    closedJobIds: [],
    skipped: 0,
    failed: 0,
  };
  for (const source of input.sources ?? LIVE_SOURCES) {
    if (source.feed !== "full") continue;
    const row = await repo.findSourceByName(source.sourceName);
    if (!row) {
      report.skipped += 1;
      continue;
    }
    const lastCheck = await repo.latestSourceCheck(row.id);
    const importedRecently = (await repo.finishedRunsSince(row.id, since)) > 0;
    // A run that started in the window may still be importing this board.
    const runStarted = await repo.sourceStartedSince(row.id, since);
    if (
      importedRecently ||
      runStarted ||
      (lastCheck !== null && lastCheck > since)
    ) {
      report.skipped += 1;
      continue;
    }
    let listed: Awaited<ReturnType<LiveSource["fetch"]>>;
    try {
      listed = await source.fetch(input.fetchImpl);
    } catch {
      report.failed += 1;
      continue;
    }
    if (!listed.length) {
      report.failed += 1;
      continue;
    }
    const listedIds = new Set(listed.map((job) => job.externalId.trim()));
    const published = await repo.publishedSourceRows(row.id);
    const alive = published
      .filter((job) => listedIds.has(job.externalId))
      .map((job) => job.externalId);
    // A non-empty list that shares nothing with our rows is a fault, not news.
    if (published.length > 0 && alive.length === 0) {
      report.failed += 1;
      continue;
    }
    const missing = published.filter((job) => !listedIds.has(job.externalId));
    // A merged job (D71) stays open while another source still lists it.
    const cutoff = new Date(now.getTime() - source.staleAfterMs);
    const split = await splitGoneEverywhere(
      missing.map((job) => job.jobId),
      row.id,
      now,
      () => cutoff,
      {
        listedExternalIds: listedIds,
        closingExternalIds: new Set(missing.map((job) => job.externalId)),
      },
    );
    const gone = missing.filter((job) => split.gone.has(job.jobId));
    const keptAlive = missing.filter((job) => !split.gone.has(job.jobId));
    const goneJobIds = [...split.gone];
    // Marks are written only once the jobs are really closed.
    if (goneJobIds.length) {
      try {
        await expireImportedJobs(goneJobIds, "closed_at_source");
      } catch {
        report.failed += 1;
        continue;
      }
    }
    await repo.markChecked(row.id, alive, "live", null, now);
    await repo.markChecked(
      row.id,
      keptAlive.map((job) => job.externalId),
      "unknown",
      "listed_elsewhere",
      now,
    );
    await repo.markChecked(
      row.id,
      gone.map((job) => job.externalId),
      "closed",
      "missing from the full board list",
      now,
    );
    report.checked += 1;
    report.closed += goneJobIds.length;
    report.closedJobIds.push(...goneJobIds);
  }
  return report;
}
