import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  findSourceByName: vi.fn(),
  dueWindowChecks: vi.fn(),
  markChecked: vi.fn(),
}));
const jobsService = vi.hoisted(() => ({
  saveImportedJob: vi.fn(),
  expireImportedJobs: vi.fn(),
}));

vi.mock("../repo/import-repo", () => repo);
vi.mock("../../../platform", () => ({ ...jobsService, normalizeSkill: vi.fn() }));

const { runLivenessSweep } = await import("../service/liveness-sweep");

const now = new Date("2026-11-27T12:00:00Z");

function due(n: number, host = "remotive.invalid", sourceId = "src-1") {
  return {
    jobId: `job-${n}`,
    sourceId,
    externalId: `ext-${n}`,
    sourceUrl: `https://${host}/jobs/${n}`,
  };
}

function res(status: number, url: string) {
  const cancel = vi.fn(async () => undefined);
  return {
    status,
    url,
    body: { cancel },
    headers: new Headers(),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.findSourceByName.mockImplementation(async (name: string) => ({
    id: `id-${name}`,
  }));
  repo.markChecked.mockResolvedValue(undefined);
});

describe("runLivenessSweep", () => {
  it("closes only the 404 job, marks each result, expires once", async () => {
    repo.dueWindowChecks.mockResolvedValue([due(1), due(2), due(3)]);
    const fetchImpl = vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.endsWith("/1")) return res(404, u);
      if (u.endsWith("/2")) return res(200, u);
      throw new Error("timeout");
    });
    const report = await runLivenessSweep({
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report).toEqual({
      probed: 3,
      live: 1,
      closed: 1,
      unknown: 1,
      partial: false,
    });
    expect(jobsService.expireImportedJobs).toHaveBeenCalledTimes(1);
    expect(jobsService.expireImportedJobs).toHaveBeenCalledWith(
      ["job-1"],
      "closed_at_source",
    );
    const calls = repo.markChecked.mock.calls.map((c) => [c[1], c[2]]);
    expect(calls).toContainEqual([["ext-1"], "closed"]);
    expect(calls).toContainEqual([["ext-2"], "live"]);
    expect(calls).toContainEqual([["ext-3"], "unknown"]);
    const first = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(first[1].method).toBe("GET");
    expect(first[1].redirect).toBe("follow");
    expect(
      (first[1].headers as Record<string, string>)["User-Agent"],
    ).toBe("IntgetionLinkCheck/1.0 (+https://intgetion.com)");
  });

  it("does not close on 403, 429 or 503", async () => {
    repo.dueWindowChecks.mockResolvedValue([due(1), due(2), due(3)]);
    const codes: Record<string, number> = { "1": 403, "2": 429, "3": 503 };
    const fetchImpl = vi.fn(async (input: unknown) => {
      const u = String(input);
      return res(codes[u.slice(-1)]!, u);
    });
    const report = await runLivenessSweep({
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.closed).toBe(0);
    expect(report.unknown).toBe(3);
    expect(jobsService.expireImportedJobs).not.toHaveBeenCalled();
  });

  it("treats a 200 on another host as unknown", async () => {
    repo.dueWindowChecks.mockResolvedValue([due(1)]);
    const fetchImpl = vi.fn(async () => res(200, "https://parked.invalid/x"));
    const report = await runLivenessSweep({
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.live).toBe(0);
    expect(report.unknown).toBe(1);
    expect(repo.markChecked).toHaveBeenCalledWith(
      "src-1",
      ["ext-1"],
      "unknown",
      "redirect_other_host",
      now,
    );
  });

  it("stops at the budget, keeps what was checked, reports partial", async () => {
    repo.dueWindowChecks.mockResolvedValue([due(1), due(2), due(3)]);
    let t = 0;
    const clock = () => {
      const v = t;
      t += 1000;
      return v;
    };
    const fetchImpl = vi.fn(async (input: unknown) => res(200, String(input)));
    const report = await runLivenessSweep({
      now,
      clock,
      budgetMs: 1500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.partial).toBe(true);
    expect(report.probed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(repo.markChecked).toHaveBeenCalledWith(
      "src-1",
      ["ext-1"],
      "live",
      "http_200",
      now,
    );
  });

  it("never runs more than 2 requests at once against one host", async () => {
    repo.dueWindowChecks.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => due(i + 1)),
    );
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (input: unknown) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return res(200, String(input));
    });
    const report = await runLivenessSweep({
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.probed).toBe(8);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it("asks only for window sources and groups marks by source", async () => {
    repo.dueWindowChecks.mockResolvedValue([
      due(1, "a.invalid", "src-1"),
      due(2, "b.invalid", "src-2"),
    ]);
    const fetchImpl = vi.fn(async (input: unknown) => res(200, String(input)));
    await runLivenessSweep({
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [ids, limit] = repo.dueWindowChecks.mock.calls[0]!;
    expect(ids.sort()).toEqual([
      "id-Himalayas",
      "id-Jobicy",
      "id-Remote OK",
      "id-Remotive",
    ]);
    expect(limit).toBe(150);
    expect(repo.markChecked).toHaveBeenCalledWith("src-1", ["ext-1"], "live", "http_200", now);
    expect(repo.markChecked).toHaveBeenCalledWith("src-2", ["ext-2"], "live", "http_200", now);
  });
});
