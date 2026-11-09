import { desc, eq } from "drizzle-orm";
import { getDb } from "@intgetion/kit";
import { importRuns, importSources } from "../../../db/owned";

/** Read-only import panel for admins (10A, D83). */
export async function listImportSources() {
  return getDb()
    .select({
      id: importSources.id,
      name: importSources.name,
      kind: importSources.kind,
      enabled: importSources.enabled,
      republishAllowed: importSources.republishAllowed,
      lastRunAt: importSources.lastRunAt,
      lastStatus: importSources.lastStatus,
    })
    .from(importSources)
    .orderBy(importSources.name);
}

export async function listImportRuns(limit: number) {
  return getDb()
    .select({
      id: importRuns.id,
      source: importSources.name,
      startedAt: importRuns.startedAt,
      finishedAt: importRuns.finishedAt,
      fetched: importRuns.fetched,
      created: importRuns.created,
      updated: importRuns.updated,
      merged: importRuns.merged,
      rejected: importRuns.rejected,
      expired: importRuns.expired,
      error: importRuns.error,
    })
    .from(importRuns)
    .innerJoin(importSources, eq(importSources.id, importRuns.sourceId))
    .orderBy(desc(importRuns.startedAt))
    .limit(limit);
}
