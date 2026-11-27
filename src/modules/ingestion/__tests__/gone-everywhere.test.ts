import { beforeEach, describe, expect, it, vi } from "vitest";
import { days, hours } from "../adapters/live";

const repo = vi.hoisted(() => ({ sourceRowsOfJobs: vi.fn() }));
vi.mock("../repo/import-repo", () => repo);

const { splitGoneEverywhere } = await import("../service/gone-everywhere");

const now = new Date("2026-11-27T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const cutoffFor = (sourceId: string) =>
  ago(sourceId === "src-short" ? hours(6) : days(30));

beforeEach(() => vi.clearAllMocks());

describe("splitGoneEverywhere", () => {
  it("closes a job only this source carried", async () => {
    repo.sourceRowsOfJobs.mockResolvedValue([
      { jobId: "j1", sourceId: "src-1", lastSeenAt: ago(days(2)), lastCheckResult: null },
    ]);
    const split = await splitGoneEverywhere(["j1"], "src-1", now, cutoffFor);
    expect([...split.gone]).toEqual(["j1"]);
    expect([...split.keptAlive]).toEqual([]);
  });

  it("keeps a job another source saw within that source's window", async () => {
    repo.sourceRowsOfJobs.mockResolvedValue([
      { jobId: "j1", sourceId: "src-1", lastSeenAt: ago(days(2)), lastCheckResult: null },
      { jobId: "j1", sourceId: "src-2", lastSeenAt: ago(days(10)), lastCheckResult: null },
    ]);
    const split = await splitGoneEverywhere(["j1"], "src-1", now, cutoffFor);
    expect([...split.keptAlive]).toEqual(["j1"]);
    expect([...split.gone]).toEqual([]);
  });

  it("uses the other source's own window", async () => {
    repo.sourceRowsOfJobs.mockResolvedValue([
      { jobId: "j1", sourceId: "src-1", lastSeenAt: ago(days(2)), lastCheckResult: null },
      { jobId: "j1", sourceId: "src-short", lastSeenAt: ago(hours(7)), lastCheckResult: "unknown" },
    ]);
    const split = await splitGoneEverywhere(["j1"], "src-1", now, cutoffFor);
    expect([...split.gone]).toEqual(["j1"]);
  });

  it("keeps a job whose other source's last check was live", async () => {
    repo.sourceRowsOfJobs.mockResolvedValue([
      { jobId: "j1", sourceId: "src-1", lastSeenAt: ago(days(2)), lastCheckResult: null },
      { jobId: "j1", sourceId: "src-short", lastSeenAt: ago(days(40)), lastCheckResult: "live" },
    ]);
    const split = await splitGoneEverywhere(["j1"], "src-1", now, cutoffFor);
    expect([...split.keptAlive]).toEqual(["j1"]);
  });

  it("asks nothing for no jobs", async () => {
    const split = await splitGoneEverywhere([], "src-1", now, cutoffFor);
    expect(repo.sourceRowsOfJobs).not.toHaveBeenCalled();
    expect(split.gone.size + split.keptAlive.size).toBe(0);
  });
});
