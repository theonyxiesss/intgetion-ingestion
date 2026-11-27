import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSource } from "../adapters/live";
import { days, hours } from "../adapters/live";
import type { RawImportedJob } from "../adapters/types";

const repo = vi.hoisted(() => ({
  findSourceByName: vi.fn(),
  finishedRunsSince: vi.fn(),
  sourceStartedSince: vi.fn(),
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
  repo.sourceStartedSince.mockResolvedValue(false);
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
      lastCheckResult: null,
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
    expect(report).toEqual({
      checked: 1,
      closed: 1,
      closedJobIds: ["job-c"],
      skipped: 0,
      failed: 0,
    });
  });

  it("closes nothing when the list is empty", async () => {
    const source = board("North", vi.fn(async () => []));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
    expect(repo.markChecked).not.toHaveBeenCalled();
    expect(report).toEqual({
      checked: 0,
      closed: 0,
      closedJobIds: [],
      skipped: 0,
      failed: 1,
    });
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
    expect(report).toEqual({
      checked: 0,
      closed: 0,
      closedJobIds: [],
      skipped: 0,
      failed: 1,
    });
  });

  it("ignores window sources", async () => {
    const fetchImpl = vi.fn(async () => [record("a")]);
    const report = await runFullSourceChecks({
      now,
      sources: [board("Remotive", fetchImpl, "window")],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report).toEqual({
      checked: 0,
      closed: 0,
      closedJobIds: [],
      skipped: 0,
      failed: 0,
    });
  });

  it("skips a source checked two hours ago", async () => {
    repo.latestSourceCheck.mockResolvedValue(new Date(now.getTime() - hours(2)));
    const fetchImpl = vi.fn(async () => [record("a")]);
    const report = await runFullSourceChecks({
      now,
      sources: [board("North", fetchImpl)],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report).toEqual({
      checked: 0,
      closed: 0,
      closedJobIds: [],
      skipped: 1,
      failed: 0,
    });
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
      { jobId: "job-c", sourceId: "src-1", lastSeenAt: new Date(now.getTime() - days(1)), lastCheckResult: null },
      { jobId: "job-c", sourceId: "src-2", lastSeenAt: new Date(now.getTime() - hours(1)), lastCheckResult: null },
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
    expect(report).toEqual({
      checked: 0,
      closed: 0,
      closedJobIds: [],
      skipped: 0,
      failed: 1,
    });
  });

  it("skips a source whose import run started within the window", async () => {
    repo.sourceStartedSince.mockResolvedValue(true);
    const fetchImpl = vi.fn(async () => [record("a")]);
    const report = await runFullSourceChecks({
      now,
      sources: [board("North", fetchImpl)],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.sourceStartedSince).toHaveBeenCalledWith(
      "src-1",
      new Date(now.getTime() - hours(20)),
    );
    expect(report.skipped).toBe(1);
  });

  it("writes no mark and counts a failure when closing throws", async () => {
    jobsService.expireImportedJobs.mockRejectedValue(new Error("db down"));
    const source = board("North", vi.fn(async () => [record("a"), record("b")]));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(repo.markChecked).not.toHaveBeenCalled();
    expect(report).toEqual({
      checked: 0,
      closed: 0,
      closedJobIds: [],
      skipped: 0,
      failed: 1,
    });
  });

  it("writes the live mark only after the jobs were closed", async () => {
    const order: string[] = [];
    jobsService.expireImportedJobs.mockImplementation(async (ids: string[]) => {
      order.push("expire");
      return ids.length;
    });
    repo.markChecked.mockImplementation(async (_s: string, _ids: string[], result: string) => {
      order.push(result);
    });
    const source = board("North", vi.fn(async () => [record("a"), record("b")]));
    await runFullSourceChecks({ now, sources: [source] });
    expect(order[0]).toBe("expire");
    expect(order).toContain("live");
    expect(order).toContain("closed");
  });

  it("keeps a job alive whose other source was last checked live", async () => {
    repo.sourceRowsOfJobs.mockResolvedValue([
      { jobId: "job-c", sourceId: "src-1", lastSeenAt: new Date(now.getTime() - days(1)), lastCheckResult: null },
      { jobId: "job-c", sourceId: "src-2", lastSeenAt: new Date(now.getTime() - days(60)), lastCheckResult: "live" },
    ]);
    const source = board("North", vi.fn(async () => [record("a"), record("b")]));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
    expect(report.closedJobIds).toEqual([]);
  });

  it("keeps a job alive through another listed row of the same source", async () => {
    repo.publishedSourceRows.mockResolvedValue([
      { externalId: "a", jobId: "job-a" },
      { externalId: "b", jobId: "job-b" },
      { externalId: "a-old", jobId: "job-a" },
    ]);
    repo.sourceRowsOfJobs.mockResolvedValue([
      { jobId: "job-a", sourceId: "src-1", externalId: "a", lastSeenAt: new Date(now.getTime() - days(1)), lastCheckResult: null },
      { jobId: "job-a", sourceId: "src-1", externalId: "a-old", lastSeenAt: new Date(now.getTime() - days(1)), lastCheckResult: null },
    ]);
    const source = board("North", vi.fn(async () => [record("a"), record("b")]));
    const report = await runFullSourceChecks({ now, sources: [source] });
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
    expect(repo.markChecked).toHaveBeenCalledWith(
      "src-1",
      ["a-old"],
      "unknown",
      "listed_elsewhere",
      now,
    );
    expect(report.closedJobIds).toEqual([]);
  });
});
