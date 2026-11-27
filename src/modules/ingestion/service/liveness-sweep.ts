import { expireImportedJobs } from "../../../platform";
import * as repo from "../repo/import-repo";
import { LIVE_SOURCES } from "./ingest-fixtures";
import {
  classifyProbe,
  PER_HOST_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  PROBE_USER_AGENT,
  SWEEP_BATCH,
  SWEEP_BUDGET_MS,
  type CheckResult,
} from "./liveness-rules";

export type LivenessSweepReport = {
  probed: number;
  live: number;
  closed: number;
  unknown: number;
  partial: boolean;
};

/** Parallel probes in total; the per-host cap is what protects the sites. */
const WORKERS = 8;

type Due = Awaited<ReturnType<typeof repo.dueWindowChecks>>[number];

function hostKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

async function probe(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ result: CheckResult; note: string }> {
  let status: number | null = null;
  let finalUrl: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": PROBE_USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    status = res.status;
    finalUrl = res.url || url;
    // Only the status matters; drop the body unread.
    await res.body?.cancel().catch(() => undefined);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    error =
      name === "TimeoutError" || name === "AbortError"
        ? "timeout"
        : "network_error";
  }
  return classifyProbe({ requestedUrl: url, finalUrl, status, error });
}

/**
 * Every 15 minutes: probes the link of published imported jobs of "window"
 * sources (the oldest check first) and closes a job only on HTTP 404 or 410.
 * Each result is stored as soon as it is known, so a run cut short by its
 * time budget keeps what it checked and the rest go first next time. Closed
 * jobs are expired in one call at the end; their mark is written after that.
 */
export async function runLivenessSweep(
  input: {
    now?: Date;
    fetchImpl?: typeof fetch;
    clock?: () => number;
    batch?: number;
    budgetMs?: number;
  } = {},
): Promise<LivenessSweepReport> {
  const now = input.now ?? new Date();
  const fetchImpl = input.fetchImpl ?? fetch;
  const clock = input.clock ?? (() => Date.now());
  const budgetMs = input.budgetMs ?? SWEEP_BUDGET_MS;
  const report: LivenessSweepReport = {
    probed: 0,
    live: 0,
    closed: 0,
    unknown: 0,
    partial: false,
  };

  const sourceIds: string[] = [];
  for (const source of LIVE_SOURCES) {
    if (source.feed !== "window") continue;
    const row = await repo.findSourceByName(source.sourceName);
    if (row) sourceIds.push(row.id);
  }
  if (!sourceIds.length) return report;

  const queue: Due[] = [
    ...(await repo.dueWindowChecks(sourceIds, input.batch ?? SWEEP_BATCH)),
  ];
  const started = clock();
  const perHost = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();
  const closed: { job: Due; note: string }[] = [];

  async function acquire(host: string) {
    while ((perHost.get(host) ?? 0) >= PER_HOST_CONCURRENCY) {
      await new Promise<void>((resolve) => {
        waiting.set(host, [...(waiting.get(host) ?? []), resolve]);
      });
    }
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
  }
  function release(host: string) {
    perHost.set(host, (perHost.get(host) ?? 1) - 1);
    const next = waiting.get(host)?.shift();
    if (next) next();
  }

  async function worker() {
    for (;;) {
      if (!queue.length) return;
      if (clock() - started >= budgetMs) {
        report.partial = true;
        return;
      }
      const job = queue.shift()!;
      const host = hostKey(job.sourceUrl);
      await acquire(host);
      let outcome: { result: CheckResult; note: string };
      try {
        outcome = await probe(job.sourceUrl, fetchImpl);
      } finally {
        release(host);
      }
      report.probed += 1;
      report[outcome.result] += 1;
      if (outcome.result === "closed") {
        closed.push({ job, note: outcome.note });
        continue;
      }
      await repo.markChecked(
        job.sourceId,
        [job.externalId],
        outcome.result,
        outcome.note,
        now,
      );
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, () => worker()));

  if (closed.length) {
    await expireImportedJobs(
      closed.map(({ job }) => job.jobId),
      "closed_at_source",
    );
    for (const { job, note } of closed) {
      await repo.markChecked(
        job.sourceId,
        [job.externalId],
        "closed",
        note,
        now,
      );
    }
  }
  return report;
}
