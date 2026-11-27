import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSource } from "../adapters/live";
import { days, hours } from "../adapters/live";
import type { RawImportedJob } from "../adapters/types";

const repo = vi.hoisted(() => ({
  findSourceByName: vi.fn(),
  finishedRunsSince: vi.fn(),
  latestSourceCheck: vi.fn(),
  publishedSourceRows: vi.fn(),
  sourceRowsOfJobs: vi.fn(),
  markChecked: vi.fn(),
  // Guards: the check must never touch these.
  ensureLiveSource: vi.fn(),
  beginImportRun: vi.fn(),
  finishImportRun: vi.fn(),
  markSourceRun: vi.fn(),
}));
const jobsService = vi.hoisted(() => ({
  saveImportedJob: vi.fn(),
  expireImportedJobs: vi.fn(),
}));

vi.mock("../repo/import-repo", () => repo);
vi.mock("../../../platform", () => ({ ...jobsService, normalizeSkill: vi.fn() }));

const { runFullSourceChecks } = await import("../service/full-source-check");

const now = new Date("2026-10-14T12:00:00Z");

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

function board(
  name: string,
  fetchImpl: LiveSource["fetch"],
  feed: LiveSource["feed"] = "full",
): LiveSource {
  return {
    sourceName: name,
    kind: "api",
    url: `https://${name.toLowerCase()}.invalid/api`,
    minIntervalMs: hours(6),
    newPerRun: 15,
    staleAfterMs: days(30),
    feed,
    fetch: fetchImpl,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.findSourceByName.mockResolvedValue({ id: "src-1" });
  repo.finishedRunsSince.mockResolvedValue(0);
  repo.latestSourceCheck.mockResolvedValue(null);
  repo.publishedSourceRows.mockResolvedValue([
    { externalId: "a", jobId: "job-a" },
    { externalId: "b", jobId: "job-b" },
    { externalId: "c", jobId: "job-c" },
  ]);
  repo.sourceRowsOfJobs.mockImplementation(async (ids: string[]) =>
    ids.map((jobId) => ({
      jobId,
      sourceId: "src-1",
      lastSeenAt: new Date(now.getTime() - days(1)),
    })),
  );
  jobsService.expireImportedJobs.mockImplementation(
    async (ids: string[]) => ids.length,
  );
});

describe("runFullSourceChecks", () => {
  it("closes published jobs gone from the full list and marks the rest live", async () => {
    const source = board("North", vi.fn(async () => [record("a"), record("b")]));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).toHaveBeenCalledWith(
      ["job-c"],
      "closed_at_source",
    );
    expect(repo.markChecked).toHaveBeenCalledWith(
      "src-1",
      ["a", "b"],
      "live",
      null,
      now,
    );
    expect(repo.markChecked).toHaveBeenCalledWith(
      "src-1",
      ["c"],
      "closed",
      expect.any(String),
      now,
    );
    expect(report).toEqual({ checked: 1, closed: 1, skipped: 0, failed: 0 });
  });

  it("closes nothing when the list is empty", async () => {
    const source = board("North", vi.fn(async () => []));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
    expect(repo.markChecked).not.toHaveBeenCalled();
    expect(report).toEqual({ checked: 0, closed: 0, skipped: 0, failed: 1 });
  });

  it("closes nothing when the fetch throws", async () => {
    const source = board(
      "North",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
    expect(repo.markChecked).not.toHaveBeenCalled();
    expect(report).toEqual({ checked: 0, closed: 0, skipped: 0, failed: 1 });
  });

  it("ignores window sources", async () => {
    const fetchImpl = vi.fn(async () => [record("a")]);
    const report = await runFullSourceChecks({
      now,
      sources: [board("Remotive", fetchImpl, "window")],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report).toEqual({ checked: 0, closed: 0, skipped: 0, failed: 0 });
  });

  it("skips a source checked two hours ago", async () => {
    repo.latestSourceCheck.mockResolvedValue(new Date(now.getTime() - hours(2)));
    const fetchImpl = vi.fn(async () => [record("a")]);
    const report = await runFullSourceChecks({
      now,
      sources: [board("North", fetchImpl)],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report).toEqual({ checked: 0, closed: 0, skipped: 1, failed: 0 });
  });

  it("skips a source imported successfully within the window", async () => {
    repo.finishedRunsSince.mockResolvedValue(1);
    const fetchImpl = vi.fn(async () => [record("a")]);
    const report = await runFullSourceChecks({
      now,
      sources: [board("North", fetchImpl)],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("skips a source that was never imported", async () => {
    repo.findSourceByName.mockResolvedValue(null);
    const fetchImpl = vi.fn(async () => [record("a")]);
    const report = await runFullSourceChecks({
      now,
      sources: [board("North", fetchImpl)],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("never writes import runs or import sources", async () => {
    const source = board("North", vi.fn(async () => [record("a")]));
    await runFullSourceChecks({ now, sources: [source] });
    expect(repo.ensureLiveSource).not.toHaveBeenCalled();
    expect(repo.beginImportRun).not.toHaveBeenCalled();
    expect(repo.finishImportRun).not.toHaveBeenCalled();
    expect(repo.markSourceRun).not.toHaveBeenCalled();
    expect(jobsService.saveImportedJob).not.toHaveBeenCalled();
  });

  it("checks again once the last check is older than maxAgeMs", async () => {
    repo.latestSourceCheck.mockResolvedValue(new Date(now.getTime() - hours(21)));
    const source = board("North", vi.fn(async () => [record("a")]));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(report.checked).toBe(1);
  });

  it("keeps a job alive that another source still lists", async () => {
    repo.sourceRowsOfJobs.mockResolvedValue([
      { jobId: "job-c", sourceId: "src-1", lastSeenAt: new Date(now.getTime() - days(1)) },
      { jobId: "job-c", sourceId: "src-2", lastSeenAt: new Date(now.getTime() - hours(1)) },
    ]);
    const source = board("North", vi.fn(async () => [record("a"), record("b")]));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
    expect(repo.markChecked).toHaveBeenCalledWith(
      "src-1",
      ["c"],
      "unknown",
      "listed_elsewhere",
      now,
    );
    expect(report.closed).toBe(0);
  });

  it("compares trimmed external ids", async () => {
    const source = board(
      "North",
      vi.fn(async () => [record(" a "), record("b"), record("c")]),
    );
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
    expect(repo.markChecked).toHaveBeenCalledWith(
      "src-1",
      ["a", "b", "c"],
      "live",
      null,
      now,
    );
    expect(report.closed).toBe(0);
  });

  it("closes nothing when the list shares no id with published rows", async () => {
    const source = board("North", vi.fn(async () => [record("x"), record("y")]));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
    expect(repo.markChecked).not.toHaveBeenCalled();
    expect(report).toEqual({ checked: 0, closed: 0, skipped: 0, failed: 1 });
  });
});
