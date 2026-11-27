import { describe, expect, it } from "vitest";
import {
  classifyProbe,
  PER_HOST_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  PROBE_USER_AGENT,
  SWEEP_BATCH,
  SWEEP_BUDGET_MS,
} from "../service/liveness-rules";

const url = "https://remotive.invalid/jobs/1";
const probe = (status: number | null, over: Record<string, unknown> = {}) =>
  classifyProbe({
    requestedUrl: url,
    finalUrl: url,
    status,
    error: null,
    ...over,
  });

describe("classifyProbe", () => {
  it("closes on 404 and 410 only", () => {
    expect(probe(404).result).toBe("closed");
    expect(probe(410).result).toBe("closed");
  });

  it("treats 2xx on the same host as live", () => {
    expect(probe(200).result).toBe("live");
    expect(probe(204, { finalUrl: "https://remotive.invalid/other" }).result).toBe(
      "live",
    );
  });

  it("treats 2xx on another host as unknown", () => {
    const r = probe(200, { finalUrl: "https://parked.invalid/stub" });
    expect(r).toEqual({ result: "unknown", note: "redirect_other_host" });
  });

  it("never closes on 403, 429, 5xx, 3xx or odd codes", () => {
    for (const status of [301, 400, 401, 403, 429, 500, 503]) {
      const r = probe(status);
      expect(r.result).toBe("unknown");
      expect(r.note).toContain(String(status));
    }
  });

  it("treats errors and missing status as unknown", () => {
    expect(
      probe(null, { finalUrl: null, error: "timeout" }),
    ).toEqual({ result: "unknown", note: "timeout" });
    expect(probe(404, { error: "boom" }).result).toBe("unknown");
    expect(probe(null).result).toBe("unknown");
  });

  it("exposes the agreed constants", () => {
    expect(PROBE_TIMEOUT_MS).toBe(10_000);
    expect(PER_HOST_CONCURRENCY).toBe(2);
    expect(SWEEP_BATCH).toBe(150);
    expect(SWEEP_BUDGET_MS).toBe(200_000);
    expect(PROBE_USER_AGENT).toBe("IntgetionLinkCheck/1.0 (+https://intgetion.com)");
  });
});
