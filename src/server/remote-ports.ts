import { HttpError } from "@intgetion/kit";
import type { IngestionPorts } from "../ports";

export type Endpoint = { url: string; token: string };

export type RemoteConfig = {
  /** feedback service: `POST /v1/events/applied-external`. */
  feedback: Endpoint;
  /** moderation service: `POST /v1/queue` (once per pending job). */
  moderation: Endpoint;
  /** platform: jobs, skills and imported companies until wired by HTTP. */
  platform: Endpoint;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * The feedback and moderation services have the endpoints already; jobs,
 * taxonomy and the imported company go to the platform callback
 * `POST /api/internal/ingestion/:op` with `{args}`.
 */
export function httpIngestionPorts(config: RemoteConfig): IngestionPorts {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;

  async function post(to: Endpoint, path: string, body: unknown) {
    const response = await doFetch(`${to.url.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${to.token}`, "content-type": "application/json" },
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await response.json().catch(() => null)) as
      | { result?: unknown; error?: { code: string; message: string } }
      | null;
    if (!response.ok) {
      if (response.status < 500 && json?.error) throw new HttpError(response.status, json.error.code, json.error.message);
      throw new Error(`${path} answered ${response.status}`);
    }
    return json;
  }
  const call = async (op: string, ...args: unknown[]) =>
    (await post(config.platform, `/api/internal/ingestion/${op}`, { args }))?.result;
  const port =
    <F extends (...a: never[]) => unknown>(op: string) =>
    ((...args: unknown[]) => call(op, ...args)) as unknown as F;

  return {
    jobs: {
      saveImportedJob: port("jobs.save-imported"),
      expireImportedJobs: port("jobs.expire-imported"),
      getJobForPublic: port("jobs.public-job"),
    },
    taxonomy: { normalizeSkill: port("taxonomy.normalize-skill") },
    findOrCreateImportedCompany: port("companies.imported-company"),
    recordAppliedExternal: async (event) => {
      await post(config.feedback, "/v1/events/applied-external", event);
    },
    queueRejectedImport: async (jobId, reason) => {
      await post(config.moderation, "/v1/queue", {
        entityType: "job",
        entityId: jobId,
        reason,
        riskFlags: [reason],
        once: true,
      });
    },
  };
}
