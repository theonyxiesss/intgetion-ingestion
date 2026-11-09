import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSource } from "../adapters/live";
import { days, hours, LIVE_STALE_AFTER_MS } from "../adapters/live";
import type { RawImportedJob } from "../adapters/types";

const repo = vi.hoisted(() => ({
  ensureLiveSource: vi.fn(),
  ensureFixtureSource: vi.fn(),
  closeStaleRuns: vi.fn(),
  sourceStartedSince: vi.fn(),
  beginImportRun: vi.fn(),
  findLinkedJobIds: vi.fn(),
  touchSourceRows: vi.fn(),
  findOrCreateImportedCompany: vi.fn(),
  findDuplicateCandidates: vi.fn(),
  linkImportedSource: vi.fn(),
  queueRejectedImport: vi.fn(),
  finishImportRun: vi.fn(),
  markSourceRun: vi.fn(),
  sourceRowsNotSeenSince: vi.fn(),
  sourceRowsOfJobs: vi.fn(),
  sourceJobsPastExpiry: vi.fn(),
  finishedRunsSince: vi.fn(),
  pruneImportRunHistory: vi.fn(),
}));
const jobsService = vi.hoisted(() => ({
  saveImportedJob: vi.fn(),
  expireImportedJobs: vi.fn(),
}));

vi.mock("../repo/import-repo", () => repo);
vi.mock("../../../platform", () => ({ ...jobsService, normalizeSkill: vi.fn() }));

const {
  LIVE_SOURCES,
  runFixtureImports,
  runLiveImports,
  STALE_RUN_AFTER_MS,
  TIME_BUDGET_ERROR,
} = await import("../service/ingest-fixtures");
const { fixtureImportAllowed, FIXTURES_NEED_LOCAL_DATABASE } =
  await import("../service/fixture-guard");
const { isGoneFromFullFeed, isStaleEverywhere } =
  await import("../service/outcome");

const now = new Date("2026-10-14T12:00:00Z");
const CLOUD_DB = "postgresql://app:secret@pooler.supabase.invalid:6543/db";
const LOCAL_DB = "postgresql://app:secret@127.0.0.1:54322/postgres";

function record(externalId: string): RawImportedJob {
  return {
    externalId,
    companyName: "North",
    companyDomain: null,
    title: `Engineer ${externalId}`,
    description: "Build and run the services of a small remote team.",
    category: "engineering",
    employmentType: "full_time",
    timeZone: null,
    skills: [],
    applyUrl: `https://jobs.invalid/${externalId}`,
    expiresAt: null,
  };
}

function live(
  name: string,
  records: RawImportedJob[] = [],
  feed: LiveSource["feed"] = "window",
): LiveSource {
  return {
    sourceName: name,
    kind: "api",
    url: `https://${name.toLowerCase()}.invalid/api`,
    minIntervalMs: hours(6),
    newPerRun: 15,
    staleAfterMs: days(30),
    feed,
    fetch: vi.fn(async () => records),
  };
}

let lastRunAt: Record<string, Date | null>;

beforeEach(() => {
  vi.clearAllMocks();
  lastRunAt = {};
  repo.ensureLiveSource.mockImplementation(
    async (source: { sourceName: string }) => ({
      id: `src-${source.sourceName}`,
      enabled: true,
      republishAllowed: true,
      lastRunAt: lastRunAt[source.sourceName] ?? null,
    }),
  );
  repo.ensureFixtureSource.mockImplementation(
    async (adapter: { sourceName: string }) => ({
      id: `src-${adapter.sourceName}`,
      enabled: false,
      republishAllowed: false,
      lastRunAt: null,
    }),
  );
  repo.closeStaleRuns.mockResolvedValue(0);
  repo.sourceStartedSince.mockResolvedValue(false);
  repo.beginImportRun.mockResolvedValue({ id: "run-1" });
  repo.findLinkedJobIds.mockResolvedValue(new Map());
  repo.findOrCreateImportedCompany.mockResolvedValue({ id: "company-1" });
  repo.findDuplicateCandidates.mockResolvedValue([]);
  repo.sourceRowsNotSeenSince.mockResolvedValue([]);
  repo.sourceRowsOfJobs.mockResolvedValue([]);
  repo.sourceJobsPastExpiry.mockResolvedValue([]);
  repo.finishedRunsSince.mockResolvedValue(0);
  jobsService.saveImportedJob.mockImplementation(
    async (input: { jobId?: string; title: string }) => ({
      id: input.jobId ?? `job-${input.title}`,
    }),
  );
  jobsService.expireImportedJobs.mockImplementation(
    async (ids: string[]) => ids.length,
  );
});

describe("live import runs (D412)", () => {
  it("every approved source drops a job only after the 30-day window", () => {
    for (const source of LIVE_SOURCES) {
      expect(source.staleAfterMs).toBe(LIVE_STALE_AFTER_MS);
    }
    expect(LIVE_STALE_AFTER_MS).toBe(days(30));
  });

  it("runs only the most overdue source in one call", async () => {
    const recent = live("Recent", [record("r1")]);
    const never = live("Never", [record("n1")]);
    const old = live("Old", [record("o1")]);
    lastRunAt = {
      Recent: new Date("2026-10-14T06:00:00Z"),
      Old: new Date("2026-10-13T00:00:00Z"),
    };

    const reports = await runLiveImports({
      sources: [recent, never, old],
      now: () => now,
      resolveSkill: async () => null,
    });

    expect(reports.map((report) => report.source)).toEqual(["Never"]);
    expect(never.fetch).toHaveBeenCalledTimes(1);
    expect(recent.fetch).not.toHaveBeenCalled();
    expect(old.fetch).not.toHaveBeenCalled();
  });

  it("passes over a source inside its interval to the next one", async () => {
    const waiting = live("Waiting", [record("w1")]);
    const due = live("Due", [record("d1")]);
    repo.sourceStartedSince.mockImplementation(
      async (sourceId: string) => sourceId === "src-Waiting",
    );

    const reports = await runLiveImports({
      sources: [waiting, due],
      now: () => now,
      resolveSkill: async () => null,
    });

    expect(reports).toMatchObject([
      { source: "Waiting", skipped: true },
      { source: "Due", skipped: false, created: 1, error: null },
    ]);
    expect(waiting.fetch).not.toHaveBeenCalled();
  });

  it("closes runs that died with their function before deciding", async () => {
    await runLiveImports({
      sources: [live("Only", [])],
      now: () => now,
      resolveSkill: async () => null,
    });
    expect(repo.closeStaleRuns).toHaveBeenCalledWith(
      "src-Only",
      new Date(now.getTime() - STALE_RUN_AFTER_MS),
    );
  });

  it("stops at the time budget, keeps listed jobs seen, and logs a partial run", async () => {
    const source = live("Slow", [
      record("known-1"),
      record("new-1"),
      record("known-2"),
      record("new-2"),
      record("new-3"),
    ]);
    repo.findLinkedJobIds.mockResolvedValue(
      new Map([
        ["known-1", "job-known-1"],
        ["known-2", "job-known-2"],
      ]),
    );
    let tick = 0;
    const clock = () => {
      tick += 1;
      // Run start, then one reading before each record: 0 s, 0 s, 100 s, 200 s.
      return Math.max(0, tick - 2) * 100_000;
    };

    const [report] = await runLiveImports({
      sources: [source],
      now: () => now,
      clock,
      timeBudgetMs: 150_000,
      resolveSkill: async () => null,
    });

    expect(repo.touchSourceRows).toHaveBeenCalledWith(
      "src-Slow",
      ["known-1", "known-2"],
      now,
    );
    // New jobs go first; the budget ran out before the known ones.
    expect(
      jobsService.saveImportedJob.mock.calls.map(([input]) => input.title),
    ).toEqual(["Engineer new-1", "Engineer new-2"]);
    expect(report).toMatchObject({
      skipped: false,
      created: 2,
      error: TIME_BUDGET_ERROR,
    });
    expect(repo.finishImportRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ created: 2 }),
      TIME_BUDGET_ERROR,
    );
    expect(repo.markSourceRun).toHaveBeenCalledWith("src-Slow", "partial");
  });

  it("does not expire a job that only left the feed, until the window passes", async () => {
    repo.sourceRowsNotSeenSince.mockResolvedValue([
      { jobId: "old", lastSeenAt: new Date("2026-09-01T00:00:00Z") },
      { jobId: "merged", lastSeenAt: new Date("2026-09-01T00:00:00Z") },
    ]);
    repo.sourceRowsOfJobs.mockResolvedValue([
      {
        jobId: "old",
        sourceId: "src-Feed",
        lastSeenAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        jobId: "merged",
        sourceId: "src-Feed",
        lastSeenAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        jobId: "merged",
        sourceId: "src-Other",
        lastSeenAt: new Date("2026-10-12T00:00:00Z"),
      },
    ]);
    repo.sourceJobsPastExpiry.mockResolvedValue(["dated"]);

    const [report] = await runLiveImports({
      sources: [live("Feed", [])],
      now: () => now,
      resolveSkill: async () => null,
    });

    expect(repo.sourceRowsNotSeenSince).toHaveBeenCalledWith(
      "src-Feed",
      new Date(now.getTime() - days(30)),
    );
    expect(jobsService.expireImportedJobs).toHaveBeenCalledWith(
      ["old", "dated"],
      "not_seen_within_window",
    );
    expect(repo.finishedRunsSince).not.toHaveBeenCalled();
    expect(report?.expired).toBe(2);
  });

  it("marks a job read in the same feed twice as linked the second time", async () => {
    await runLiveImports({
      sources: [live("Twice", [record("same"), record("same")])],
      now: () => now,
      resolveSkill: async () => null,
    });
    const targets = jobsService.saveImportedJob.mock.calls.map(
      ([input]) => input.jobId,
    );
    expect(targets).toEqual([undefined, "job-Engineer same"]);
  });
});

describe("company boards are whole lists (D416)", () => {
  const runAt = now;
  const earlier = new Date("2026-10-13T12:00:00Z");

  it("expires a job the board no longer lists, but not one another source still shows", async () => {
    repo.sourceRowsNotSeenSince.mockResolvedValue([
      { jobId: "gone", lastSeenAt: earlier },
      { jobId: "elsewhere", lastSeenAt: earlier },
    ]);
    repo.sourceRowsOfJobs.mockResolvedValue([
      { jobId: "gone", sourceId: "src-Board", lastSeenAt: earlier },
      { jobId: "elsewhere", sourceId: "src-Board", lastSeenAt: earlier },
      {
        jobId: "elsewhere",
        sourceId: "src-Feed",
        lastSeenAt: new Date("2026-10-12T00:00:00Z"),
      },
    ]);

    await runLiveImports({
      sources: [live("Board", [record("still-open")], "full")],
      now: () => runAt,
      resolveSkill: async () => null,
    });

    // Asked for rows unseen since this run, not since the 30-day cutoff.
    expect(repo.sourceRowsNotSeenSince).toHaveBeenCalledWith(
      "src-Board",
      runAt,
    );
    expect(jobsService.expireImportedJobs).toHaveBeenCalledWith(
      ["gone"],
      "not_seen_within_window",
    );
  });

  it("treats an empty board as a fault and only applies the window", async () => {
    await runLiveImports({
      sources: [live("Empty", [], "full")],
      now: () => runAt,
      resolveSkill: async () => null,
    });
    expect(repo.sourceRowsNotSeenSince).toHaveBeenCalledWith(
      "src-Empty",
      new Date(runAt.getTime() - days(30)),
    );
  });

  it("keeps every listed known job seen, beyond the 500 written in one run", async () => {
    const many = Array.from({ length: 520 }, (_, index) =>
      record(`job-${index}`),
    );
    repo.findLinkedJobIds.mockResolvedValue(
      new Map(many.map((job) => [job.externalId, `id-${job.externalId}`])),
    );
    await runLiveImports({
      sources: [live("Big", many, "full")],
      now: () => runAt,
      resolveSkill: async () => null,
      timeBudgetMs: 0,
    });
    const touched = repo.touchSourceRows.mock.calls[0]?.[1] as string[];
    expect(touched).toHaveLength(520);
    expect(touched).toContain("job-519");
  });

  it("isGoneFromFullFeed needs this board to have missed it and no fresh other source", () => {
    const cutoff = new Date(runAt.getTime() - days(30));
    expect(
      isGoneFromFullFeed(
        [{ lastSeenAt: earlier, currentSource: true }],
        runAt,
        cutoff,
      ),
    ).toBe(true);
    expect(
      isGoneFromFullFeed(
        [{ lastSeenAt: runAt, currentSource: true }],
        runAt,
        cutoff,
      ),
    ).toBe(false);
    expect(
      isGoneFromFullFeed(
        [
          { lastSeenAt: earlier, currentSource: true },
          { lastSeenAt: earlier, currentSource: false },
        ],
        runAt,
        cutoff,
      ),
    ).toBe(false);
    expect(
      isGoneFromFullFeed(
        [{ lastSeenAt: earlier, currentSource: false }],
        runAt,
        cutoff,
      ),
    ).toBe(false);
  });
});

describe("fixture feeds stay off a shared database (D412)", () => {
  const adapter = {
    sourceName: "Fictional API Feed",
    kind: "api" as const,
    loadFixture: vi.fn(async () => [record("fx-1")]),
  };

  it("runs nothing against a database that is not on this machine", async () => {
    const reports = await runFixtureImports({
      adapters: [adapter],
      databaseUrl: () => CLOUD_DB,
      now: () => now,
    });
    expect(reports).toEqual([
      expect.objectContaining({
        source: "Fictional API Feed",
        skipped: true,
        error: FIXTURES_NEED_LOCAL_DATABASE,
      }),
    ]);
    expect(repo.ensureFixtureSource).not.toHaveBeenCalled();
    expect(adapter.loadFixture).not.toHaveBeenCalled();
    expect(jobsService.saveImportedJob).not.toHaveBeenCalled();
  });

  it("runs against a local database, as in CI", async () => {
    const reports = await runFixtureImports({
      adapters: [adapter],
      databaseUrl: () => LOCAL_DB,
      now: () => now,
      resolveSkill: async () => null,
    });
    expect(reports[0]).toMatchObject({ skipped: false, created: 1 });
  });

  it("knows a local database by its host only", () => {
    expect(fixtureImportAllowed(LOCAL_DB)).toBe(true);
    expect(fixtureImportAllowed("postgres://u@localhost:5432/x")).toBe(true);
    expect(fixtureImportAllowed("postgres://u@[::1]:5432/x")).toBe(true);
    expect(fixtureImportAllowed(CLOUD_DB)).toBe(false);
    expect(
      fixtureImportAllowed("postgres://u@db.localhost.invalid:5432/x"),
    ).toBe(false);
    expect(fixtureImportAllowed(undefined)).toBe(false);
    expect(fixtureImportAllowed("not a url")).toBe(false);
  });
});

describe("staleness of a live job (D412)", () => {
  const cutoff = new Date("2026-09-14T12:00:00Z");

  it("is stale only when every source last saw it before the cutoff", () => {
    expect(
      isStaleEverywhere(
        [{ lastSeenAt: new Date("2026-09-01T00:00:00Z") }],
        cutoff,
      ),
    ).toBe(true);
    expect(
      isStaleEverywhere(
        [
          { lastSeenAt: new Date("2026-09-01T00:00:00Z") },
          { lastSeenAt: new Date("2026-10-01T00:00:00Z") },
        ],
        cutoff,
      ),
    ).toBe(false);
    expect(isStaleEverywhere([], cutoff)).toBe(false);
  });
});
