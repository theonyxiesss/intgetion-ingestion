import { matchesScamPattern } from "../../../config/scam-patterns";
import { expireImportedJobs, saveImportedJob } from "../../../platform";
import { normalizeSkill } from "../../../platform";
import { apiFixtureAdapter } from "../adapters/api-fixture";
import { COMPANY_BOARD_SOURCES } from "../adapters/company-boards";
import { himalayasSource } from "../adapters/himalayas";
import { jobicySource } from "../adapters/jobicy";
import { withinCreateBudget, type LiveSource } from "../adapters/live";
import { remoteOkSource } from "../adapters/remoteok";
import { remotiveSource } from "../adapters/remotive";
import { rssFixtureAdapter } from "../adapters/rss-fixture";
import type { ImportAdapter, RawImportedJob } from "../adapters/types";
import * as repo from "../repo/import-repo";
import { pickDuplicate } from "./dedup";
import {
  fixtureImportAllowed,
  FIXTURES_NEED_LOCAL_DATABASE,
} from "./fixture-guard";
import { normalizeImportedJob, type SkillResolver } from "./normalize";
import {
  decideOutcome,
  isGoneFromFullFeed,
  isMissingEverywhere,
  isStaleEverywhere,
} from "./outcome";

export const FIXTURE_ADAPTERS: readonly ImportAdapter[] = [
  apiFixtureAdapter,
  rssFixtureAdapter,
];

/**
 * Official APIs the founder approved for republishing (D18, D375). Each one
 * runs only when IMPORT_LIVE_ENABLED=true and its row is enabled with
 * republish allowed. The first live run creates that row turned on. A later
 * run does not turn a switched-off row back on.
 */
export const LIVE_SOURCES: readonly LiveSource[] = [
  remotiveSource,
  himalayasSource,
  jobicySource,
  remoteOkSource,
  // D416: one source per company career board.
  ...COMPANY_BOARD_SOURCES,
];

/** A source is imported at most once an hour (section 7, cron ≥ 1 h). */
export const MIN_RUN_INTERVAL_MS = 60 * 60 * 1000;
/** 13.1: at most 500 records per run. */
export const MAX_RECORDS_PER_RUN = 500;
/**
 * D412: the cron function may live 300 s. A live run stops taking records
 * after 200 s, so it can still expire, finish and log what it did.
 */
export const LIVE_TIME_BUDGET_MS = 200_000;
/** An unfinished run older than this died with its function (D412). */
export const STALE_RUN_AFTER_MS = 15 * 60 * 1000;
export const TIME_BUDGET_ERROR = "partial: the time budget ran out";

export type ImportReport = repo.RunCounters & {
  source: string;
  skipped: boolean;
  error: string | null;
};

type Dependencies = {
  adapters: readonly ImportAdapter[];
  load: (adapter: ImportAdapter) => Promise<RawImportedJob[]>;
  resolveSkill: SkillResolver;
  isScam: (text: string) => boolean;
  now: () => Date;
  /** Wall clock for the time budget, apart from `now` so tests can move it. */
  clock: () => number;
  /** Fixtures run only when this is a database on this machine (D412). */
  databaseUrl: () => string | undefined;
  /** Live sources run less often, by their own terms (D375). */
  minIntervalMs?: number;
  /** When set, only this many new jobs are written; known ones still refresh. */
  createLimit?: number;
  /** When set, records after this long wait for the next run (D412). */
  timeBudgetMs?: number;
  /** Live sources: the stored row decides whether the source may run. */
  live?: LiveSource;
};

const defaults: Dependencies = {
  adapters: FIXTURE_ADAPTERS,
  load: (adapter) => adapter.loadFixture(),
  // Unknown skills land in skill_suggestions with source "import" (13.2).
  resolveSkill: async (value) => {
    const result = await normalizeSkill(value, "import");
    return result.result === "matched" ? result.skillId : null;
  },
  isScam: matchesScamPattern,
  now: () => new Date(),
  clock: () => Date.now(),
  databaseUrl: () => process.env.DATABASE_URL,
};

function emptyCounters(): repo.RunCounters {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    merged: 0,
    rejected: 0,
    expired: 0,
  };
}

/**
 * Runs every fixture source once (8A); no network access at all. Against a
 * database that is not on this machine nothing runs (D412).
 */
export async function runFixtureImports(
  overrides: Partial<Dependencies> = {},
): Promise<ImportReport[]> {
  const deps: Dependencies = { ...defaults, ...overrides };
  if (!fixtureImportAllowed(deps.databaseUrl())) {
    return deps.adapters.map((adapter) => ({
      ...emptyCounters(),
      source: adapter.sourceName,
      skipped: true,
      error: FIXTURES_NEED_LOCAL_DATABASE,
    }));
  }
  const reports: ImportReport[] = [];
  for (const adapter of deps.adapters) {
    reports.push(await importSource(adapter, deps));
  }
  await repo.pruneImportRunHistory(deps.now());
  return reports;
}

/**
 * Runs the most overdue approved live source (8B, D375) with a budget of new
 * jobs and of time. One source per call (D412): the hourly cron reaches each
 * of them in turn, and a slow one cannot starve the others.
 */
export async function runLiveImports(
  overrides: Partial<Dependencies> & { sources?: readonly LiveSource[] } = {},
): Promise<ImportReport[]> {
  const { sources = LIVE_SOURCES, ...rest } = overrides;
  const now = rest.now ?? defaults.now;
  const registered: { live: LiveSource; lastRunAt: number }[] = [];
  for (const live of sources) {
    const row = await repo.ensureLiveSource(live);
    registered.push({ live, lastRunAt: row.lastRunAt?.getTime() ?? 0 });
  }
  // Never run first, then the oldest last run. The sort is stable.
  registered.sort((a, b) => a.lastRunAt - b.lastRunAt);

  const reports: ImportReport[] = [];
  for (const { live } of registered) {
    const adapter: ImportAdapter = {
      sourceName: live.sourceName,
      kind: live.kind,
      loadFixture: () => live.fetch(),
    };
    const report = await importSource(adapter, {
      ...defaults,
      load: () => live.fetch(),
      timeBudgetMs: LIVE_TIME_BUDGET_MS,
      ...rest,
      minIntervalMs: live.minIntervalMs,
      createLimit: live.newPerRun,
      live,
    });
    reports.push(report);
    if (!report.skipped) break;
  }
  await repo.pruneImportRunHistory(now());
  return reports;
}

async function importSource(
  adapter: ImportAdapter,
  deps: Dependencies,
): Promise<ImportReport> {
  const now = deps.now();
  const source = deps.live
    ? await repo.ensureLiveSource(deps.live)
    : await repo.ensureFixtureSource(adapter);
  await repo.closeStaleRuns(
    source.id,
    new Date(now.getTime() - STALE_RUN_AFTER_MS),
  );
  const counters = emptyCounters();
  const switchedOff =
    deps.live !== undefined && !(source.enabled && source.republishAllowed);
  const interval = deps.minIntervalMs ?? MIN_RUN_INTERVAL_MS;
  // Every started run counts, a failed one too: the source's request limit.
  if (
    switchedOff ||
    (await repo.sourceStartedSince(
      source.id,
      new Date(now.getTime() - interval),
    ))
  ) {
    return {
      ...counters,
      source: adapter.sourceName,
      skipped: true,
      error: null,
    };
  }

  const run = await repo.beginImportRun(source.id, now);
  const startedAt = deps.clock();
  let partial = false;
  try {
    const listed = await deps.load(adapter);
    // Every listed known job is still open, beyond the 500 written too.
    const linked = await repo.findLinkedJobIds(source.id, [
      ...new Set(listed.map((record) => record.externalId.trim())),
    ]);
    await repo.touchSourceRows(source.id, [...linked.keys()], now);
    const loaded = listed.slice(0, MAX_RECORDS_PER_RUN);
    const records =
      deps.createLimit === undefined
        ? loaded
        : withinCreateBudget(loaded, new Set(linked.keys()), deps.createLimit);
    counters.fetched = records.length;
    // New jobs first: a known one was just marked as seen.
    const isKnown = (record: RawImportedJob) =>
      linked.has(record.externalId.trim());
    const ordered = [
      ...records.filter((record) => !isKnown(record)),
      ...records.filter(isKnown),
    ];
    for (const raw of ordered) {
      if (
        deps.timeBudgetMs !== undefined &&
        deps.clock() - startedAt > deps.timeBudgetMs
      ) {
        partial = true;
        break;
      }
      const job = await normalizeImportedJob(
        raw,
        deps.resolveSkill,
        now,
        deps.isScam,
      );
      const company = await repo.findOrCreateImportedCompany(
        job.companyName,
        job.companyDomain,
      );
      const linkedJobId = linked.get(job.externalId) ?? null;
      const duplicate = pickDuplicate(
        job,
        (
          await repo.findDuplicateCandidates({
            importedCompanyId: company.id,
            companyName: job.companyName,
            companyDomain: job.companyDomain,
            title: job.title,
            description: job.description,
          })
        ).filter((candidate) => candidate.jobId !== linkedJobId),
      );
      const outcome = decideOutcome({
        scam: job.scam,
        expired: job.expired,
        alreadyLinked: linkedJobId !== null,
        duplicate: duplicate?.source ?? null,
      });
      // Write into the linked job, or merge into an imported duplicate.
      const targetJobId =
        linkedJobId ??
        (duplicate?.source === "imported" ? duplicate.jobId : undefined);
      const saved = await saveImportedJob({
        jobId: targetJobId,
        companyId: company.id,
        title: job.title,
        description: job.description,
        category: job.category,
        employmentType: job.employmentType,
        timeZone: job.timeZone,
        skillIds: job.skillIds,
        sectors: job.sectors,
        seniority: job.seniority,
        workFormat: job.workFormat,
        location: job.location,
        countries: job.countries,
        applyUrl: job.applyUrl,
        expiresAt: job.expiresAt ? new Date(job.expiresAt) : null,
        status: outcome.status,
        reason: outcome.reason,
      });
      await repo.linkImportedSource(
        saved.id,
        source.id,
        job.externalId,
        job.applyUrl,
        now,
      );
      linked.set(job.externalId, saved.id);
      if (outcome.queueForReview) {
        await repo.queueRejectedImport(saved.id, outcome.reason);
      }
      counters[outcome.counter] += 1;
    }
    if (deps.live) {
      counters.expired += await expireStale(
        source.id,
        now,
        deps.live.staleAfterMs,
        // D416: a whole board that lists nothing is a fault, not news.
        deps.live.feed === "full" && listed.length > 0,
      );
    } else if (!partial) {
      // «Missing from the feed» needs the whole feed read.
      counters.expired += await expireMissing(source.id, now);
    }
    const error = partial ? TIME_BUDGET_ERROR : null;
    await repo.finishImportRun(run.id, counters, error);
    await repo.markSourceRun(source.id, partial ? "partial" : "success");
    return {
      ...counters,
      source: adapter.sourceName,
      skipped: false,
      error,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 1000) : "Import failed";
    await repo.finishImportRun(run.id, counters, message);
    await repo.markSourceRun(source.id, "error");
    return {
      ...counters,
      source: adapter.sourceName,
      skipped: false,
      error: message,
    };
  }
}

/**
 * Live feeds (D412): published jobs no source has listed within the window,
 * and jobs whose own expiry date from the source has passed.
 */
async function expireStale(
  sourceId: string,
  now: Date,
  staleAfterMs: number,
  fullFeed = false,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  // A full board lists every open job, so anything it did not list now is gone.
  const unseen = await repo.sourceRowsNotSeenSince(
    sourceId,
    fullFeed ? now : cutoff,
  );
  const seenByJob = new Map<
    string,
    { lastSeenAt: Date; currentSource: boolean }[]
  >();
  if (unseen.length) {
    const rows = await repo.sourceRowsOfJobs([
      ...new Set(unseen.map((row) => row.jobId)),
    ]);
    for (const row of rows) {
      seenByJob.set(row.jobId, [
        ...(seenByJob.get(row.jobId) ?? []),
        {
          lastSeenAt: row.lastSeenAt,
          currentSource: row.sourceId === sourceId,
        },
      ]);
    }
  }
  const stale = [...seenByJob.entries()]
    .filter(([, seen]) =>
      fullFeed
        ? isGoneFromFullFeed(seen, now, cutoff)
        : isStaleEverywhere(seen, cutoff),
    )
    .map(([jobId]) => jobId);
  const pastExpiry = await repo.sourceJobsPastExpiry(sourceId, now);
  return expireImportedJobs(
    [...new Set([...stale, ...pastExpiry])],
    "not_seen_within_window",
  );
}

/** Published jobs from this source that every one of their sources lost. */
async function expireMissing(sourceId: string, now: Date): Promise<number> {
  const unseen = await repo.sourceRowsNotSeenSince(sourceId, now);
  if (!unseen.length) return 0;
  const rows = await repo.sourceRowsOfJobs([
    ...new Set(unseen.map((r) => r.jobId)),
  ]);
  const byJob = new Map<
    string,
    { currentSource: boolean; finishedRunsSinceSeen: number }[]
  >();
  for (const row of rows) {
    const entry = {
      currentSource: row.sourceId === sourceId,
      finishedRunsSinceSeen: await repo.finishedRunsSince(
        row.sourceId,
        row.lastSeenAt,
      ),
    };
    byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), entry]);
  }
  const missing = [...byJob.entries()]
    .filter(([, sources]) => isMissingEverywhere(sources))
    .map(([jobId]) => jobId);
  return expireImportedJobs(missing);
}

/** One named fixture source, or all of them. */
export async function runFixtureImport(sourceName?: string) {
  const adapters = sourceName
    ? FIXTURE_ADAPTERS.filter((adapter) => adapter.sourceName === sourceName)
    : FIXTURE_ADAPTERS;
  if (!adapters.length) throw new Error("Unknown fixture source");
  return runFixtureImports({ adapters });
}
