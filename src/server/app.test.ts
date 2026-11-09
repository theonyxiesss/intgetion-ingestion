import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { httpIngestionPorts } from "./remote-ports";

const token = "test-token";
const app = createApp({ serviceToken: token, liveImport: false });
const auth = { authorization: `Bearer ${token}` };
const call = (path: string, init: RequestInit = {}) => app(new Request(`http://ingestion${path}`, init));

describe("ingestion http", () => {
  it("serves health without a token and refuses a missing one", async () => {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/v1/admin/runs")).status).toBe(401);
  });
  it("answers 404 for a bad job id and unknown routes", async () => {
    expect((await call("/v1/jobs/nope/apply-external", { method: "POST", headers: auth })).status).toBe(404);
    expect((await call("/v1/nothing", { headers: auth })).status).toBe(404);
  });
});

describe("remote ports", () => {
  it("queues once with moderation, records with feedback, keeps an owner's 4xx", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const path = String(url);
      if (path === "http://m/v1/queue" || path === "http://f/v1/events/applied-external") return Response.json({ ok: true });
      if (path.endsWith("/companies.imported-company")) return Response.json({ result: { id: "c1" } });
      return Response.json({ error: { code: "NOT_FOUND", message: "no" } }, { status: 404 });
    });
    const ports = httpIngestionPorts({
      feedback: { url: "http://f", token: "a" },
      moderation: { url: "http://m/", token: "b" },
      platform: { url: "http://p", token: "c" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    await ports.queueRejectedImport("j1", "scam_pattern_rejected");
    const queued = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(queued).toMatchObject({ entityType: "job", entityId: "j1", once: true });
    await ports.recordAppliedExternal({ userId: "u", jobId: "j1" });
    expect(await ports.findOrCreateImportedCompany("Acme", null)).toEqual({ id: "c1" });
    await expect(ports.jobs.getJobForPublic("j1")).rejects.toMatchObject({ status: 404 });
  });
});
