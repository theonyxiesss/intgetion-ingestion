import { expireImportedJobs } from "../../../platform";
import { hours, type LiveSource } from "../adapters/live";
import * as repo from "../repo/import-repo";
import { LIVE_SOURCES } from "./ingest-fixtures";

/** A full source is checked again when nothing touched it this long. */
export const FULL_CHECK_MAX_AGE_MS = hours(20);

export type FullSourceCheckReport = {
  checked: number;
  closed: number;
  skipped: number;
  failed: number;
};

/**
 * Daily check of "full" company boards: a published job missing from a
 * successfully downloaded, non-empty list is closed at the source. A failed
 * or empty list closes nothing. Jobs are not saved or updated, and neither
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
    if (importedRecently || (lastCheck !== null && lastCheck > since)) {
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
    const listedIds = new Set(listed.map((job) => job.externalId));
    const published = await repo.publishedSourceRows(row.id);
    const alive = published
      .filter((job) => listedIds.has(job.externalId))
      .map((job) => job.externalId);
    const gone = published.filter((job) => !listedIds.has(job.externalId));
    await repo.markChecked(row.id, alive, "live", null, now);
    if (gone.length) {
      await repo.markChecked(
        row.id,
        gone.map((job) => job.externalId),
        "closed",
        "missing from the full board list",
        now,
      );
      await expireImportedJobs(
        gone.map((job) => job.jobId),
        "closed_at_source",
      );
    }
    report.checked += 1;
    report.closed += gone.length;
  }
  return report;
}
