export type CheckResult = "live" | "closed" | "unknown";

/** One request to a job link gives up after this long. */
export const PROBE_TIMEOUT_MS = 10_000;
/** At most this many requests to one host at the same time. */
export const PER_HOST_CONCURRENCY = 2;
/** Jobs probed per sweep run (a run every 15 minutes covers the day). */
export const SWEEP_BATCH = 150;
/** A sweep stops starting new probes after this long. */
export const SWEEP_BUDGET_MS = 200_000;
export const PROBE_USER_AGENT = "IntgetionLinkCheck/1.0 (+https://intgetion.com)";

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Only a 404 or 410 closes a job. Everything else (blocks, rate limits,
 * server errors, timeouts, a redirect to another host) is "unknown" and the
 * job stays published.
 */
export function classifyProbe(input: {
  requestedUrl: string;
  finalUrl: string | null;
  status: number | null;
  error: string | null;
}): { result: CheckResult; note: string } {
  if (input.error !== null) return { result: "unknown", note: input.error };
  if (input.status === null) return { result: "unknown", note: "no_response" };
  if (input.status === 404 || input.status === 410) {
    return { result: "closed", note: `http_${input.status}` };
  }
  if (input.status >= 200 && input.status <= 299) {
    const requested = hostOf(input.requestedUrl);
    const final = hostOf(input.finalUrl);
    if (requested !== null && requested === final) {
      return { result: "live", note: `http_${input.status}` };
    }
    return { result: "unknown", note: "redirect_other_host" };
  }
  return { result: "unknown", note: `http_${input.status}` };
}
