import { ingestionPorts } from "../../../ports";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@intgetion/kit";
import {
  companies,
  importRuns,
  importSources,
  jobSources,
  jobs,
} from "../../../db/owned";
import type { ImportAdapter } from "../adapters/types";
import type { DuplicateCandidate } from "../service/dedup";

/** Queries only; the rules live in service/ (3.2). */

export const COMPANY_NAME_SIMILARITY = 0.9;

export async function ensureFixtureSource(adapter: ImportAdapter) {
  const [row] = await getDb()
    .insert(importSources)
    .values({ name: adapter.sourceName, kind: adapter.kind, enabled: false })
    .onConflictDoUpdate({
      target: importSources.name,
      set: { kind: adapter.kind },
    })
    .returning();
  if (!row) throw new Error("Could not register fixture source");
  return row;
}

/**
 * Registers a live source. The first insert turns it on. A later run does
 * not turn it back on, so an admin switch stays off.
 */
export async function ensureLiveSource(source: {
  sourceName: string;
  kind: "api" | "rss";
  url: string;
}) {
  const [row] = await getDb()
    .insert(importSources)
    .values({
      name: source.sourceName,
      kind: source.kind,
      url: source.url,
      enabled: true,
      republishAllowed: true,
    })
    .onConflictDoUpdate({
      target: importSources.name,
      set: { kind: source.kind, url: source.url },
    })
    .returning();
  if (!row) throw new Error("Could not register live source");
  return row;
}

export async function sourceStartedSince(sourceId: string, since: Date) {
  const [run] = await getDb()
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(
      and(eq(importRuns.sourceId, sourceId), gt(importRuns.startedAt, since)),
    )
    .limit(1);
  return Boolean(run);
}

export async function beginImportRun(sourceId: string, startedAt: Date) {
  const [run] = await getDb()
    .insert(importRuns)
    .values({ sourceId, startedAt })
    .returning();
  if (!run) throw new Error("Could not create import run");
  return run;
}

export type RunCounters = {
  fetched: number;
  created: number;
  updated: number;
  merged: number;
  rejected: number;
  expired: number;
};

export async function finishImportRun(
  runId: string,
  counters: RunCounters,
  error: string | null,
) {
  await getDb()
    .update(importRuns)
    .set({ ...counters, error, finishedAt: new Date() })
    .where(eq(importRuns.id, runId));
}

export async function markSourceRun(sourceId: string, status: string) {
  await getDb()
    .update(importSources)
    .set({ lastRunAt: new Date(), lastStatus: status })
    .where(eq(importSources.id, sourceId));
}

/**
 * 13.2: an imported company by domain, then by name similarity ≥ 0.9 among
 * imported companies; otherwise a new imported, unverified company. Internal
 * companies are never matched, so an import cannot take one over.
 */
export async function findOrCreateImportedCompany(name: string, domain: string | null) {
  return ingestionPorts().findOrCreateImportedCompany(name, domain);
}

export const STALE_RUN_ERROR = "timed_out: the run never finished";

/**
 * Unfinished runs older than `before` died with their function (timeout).
 * They get an error and a finish time so they never count as a success.
 */
export async function closeStaleRuns(sourceId: string, before: Date) {
  const closed = await getDb()
    .update(importRuns)
    .set({ finishedAt: new Date(), error: STALE_RUN_ERROR })
    .where(
      and(
        eq(importRuns.sourceId, sourceId),
        isNull(importRuns.finishedAt),
        lt(importRuns.startedAt, before),
      ),
    )
    .returning({ id: importRuns.id });
  return closed.length;
}

/** External id → job id for the ids of one feed, in one query. */
export async function findLinkedJobIds(
  sourceId: string,
  externalIds: readonly string[],
): Promise<Map<string, string>> {
  if (!externalIds.length) return new Map();
  const rows = await getDb()
    .select({ externalId: jobSources.externalId, jobId: jobSources.jobId })
    .from(jobSources)
    .where(
      and(
        eq(jobSources.importSourceId, sourceId),
        inArray(jobSources.externalId, [...externalIds]),
      ),
    );
  return new Map(rows.map((row) => [row.externalId, row.jobId]));
}

/** The feed still lists these jobs: one update, before any slow work. */
export async function touchSourceRows(
  sourceId: string,
  externalIds: readonly string[],
  seenAt: Date,
) {
  if (!externalIds.length) return;
  await getDb()
    .update(jobSources)
    .set({ lastSeenAt: seenAt })
    .where(
      and(
        eq(jobSources.importSourceId, sourceId),
        inArray(jobSources.externalId, [...externalIds]),
      ),
    );
}

export async function findLinkedJobId(
  sourceId: string,
  externalId: string,
): Promise<string | null> {
  const [row] = await getDb()
    .select({ jobId: jobSources.jobId })
    .from(jobSources)
    .where(
      and(
        eq(jobSources.importSourceId, sourceId),
        eq(jobSources.externalId, externalId),
      ),
    )
    .limit(1);
  return row?.jobId ?? null;
}

/**
 * Possible duplicates for 13.3: jobs of the same imported company, and
 * internal jobs of internal companies with the same domain or a name
 * similarity ≥ 0.9. Similarities come from pg_trgm; service/dedup decides.
 */
export async function findDuplicateCandidates(input: {
  importedCompanyId: string;
  companyName: string;
  companyDomain: string | null;
  title: string;
  description: string;
}): Promise<DuplicateCandidate[]> {
  const titleSimilarity = sql<number>`public.skill_similarity(${jobs.title}, ${input.title})`;
  const descriptionSimilarity = sql<number>`public.skill_similarity(left(${jobs.description}, 500), left(${input.description}, 500))`;
  const sameInternalCompany = input.companyDomain
    ? sql`(${companies.domain} = ${input.companyDomain} or public.skill_similarity(${companies.name}, ${input.companyName}) >= ${COMPANY_NAME_SIMILARITY})`
    : sql`public.skill_similarity(${companies.name}, ${input.companyName}) >= ${COMPANY_NAME_SIMILARITY}`;
  const rows = await getDb()
    .select({
      jobId: jobs.id,
      source: jobs.source,
      title: jobs.title,
      location: jobs.location,
      companyName: companies.name,
      companyDomain: companies.domain,
      titleSimilarity,
      descriptionSimilarity,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(
      and(
        ne(jobs.status, "removed"),
        sql`(
          (${jobs.companyId} = ${input.importedCompanyId} and ${jobs.source} = 'imported')
          or (${jobs.source} = 'internal' and ${companies.origin} = 'internal' and ${sameInternalCompany})
        )`,
      ),
    )
    .orderBy(desc(titleSimilarity))
    .limit(50);
  return rows.map((row) => ({
    ...row,
    titleSimilarity: Number(row.titleSimilarity),
    descriptionSimilarity: Number(row.descriptionSimilarity),
  }));
}

/**
 * Upserts the (source, external id) row. The first source row of a job is
 * its primary one; later sources add non-primary rows (D71).
 */
export async function linkImportedSource(
  jobId: string,
  sourceId: string,
  externalId: string,
  sourceUrl: string,
  seenAt: Date,
) {
  await getDb()
    .insert(jobSources)
    .values({
      jobId,
      importSourceId: sourceId,
      externalId,
      sourceUrl,
      lastSeenAt: seenAt,
      isPrimary: sql`not exists (select 1 from public.job_sources s where s.job_id = ${jobId} and s.is_primary)`,
    })
    .onConflictDoUpdate({
      target: [jobSources.importSourceId, jobSources.externalId],
      set: { jobId, sourceUrl, lastSeenAt: seenAt },
    });
}

/** Source rows of published imported jobs from this source not seen at `since`. */
export async function sourceRowsNotSeenSince(sourceId: string, since: Date) {
  return getDb()
    .select({ jobId: jobSources.jobId, lastSeenAt: jobSources.lastSeenAt })
    .from(jobSources)
    .innerJoin(jobs, eq(jobs.id, jobSources.jobId))
    .where(
      and(
        eq(jobSources.importSourceId, sourceId),
        eq(jobs.source, "imported"),
        eq(jobs.status, "published"),
        lt(jobSources.lastSeenAt, since),
      ),
    );
}

/** Published imported jobs of this source whose source expiry date passed. */
export async function sourceJobsPastExpiry(
  sourceId: string,
  now: Date,
): Promise<string[]> {
  const rows = await getDb()
    .select({ jobId: jobSources.jobId })
    .from(jobSources)
    .innerJoin(jobs, eq(jobs.id, jobSources.jobId))
    .where(
      and(
        eq(jobSources.importSourceId, sourceId),
        eq(jobs.source, "imported"),
        eq(jobs.status, "published"),
        lte(jobs.expiresAt, now),
      ),
    );
  return rows.map((row) => row.jobId);
}

/**
 * Successful runs of a source that started after a moment. A run that
 * timed out or stopped at its time budget did not read the whole feed (D412).
 */
export async function finishedRunsSince(sourceId: string, since: Date) {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.sourceId, sourceId),
        isNotNull(importRuns.finishedAt),
        isNull(importRuns.error),
        gt(importRuns.startedAt, since),
      ),
    );
  return Number(row?.count ?? 0);
}

export async function sourceRowsOfJobs(jobIds: string[]) {
  if (!jobIds.length) return [];
  return getDb()
    .select({
      jobId: jobSources.jobId,
      sourceId: jobSources.importSourceId,
      lastSeenAt: jobSources.lastSeenAt,
    })
    .from(jobSources)
    .where(inArray(jobSources.jobId, jobIds));
}

/**
 * 13.4: rejected imports go to the admin queue for sample review; one
 * pending row per job, so repeated runs do not pile up.
 */
export async function queueRejectedImport(jobId: string, reason: string) {
  await ingestionPorts().queueRejectedImport(jobId, reason);
}

export async function pruneImportRunHistory(now: Date) {
  const before = new Date(now.getTime() - 180 * 86400000);
  await getDb().delete(importRuns).where(lt(importRuns.startedAt, before));
}
