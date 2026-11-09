import {
  LIVE_STALE_AFTER_MS,
  employment,
  fetchJson,
  hours,
  idOf,
  mapRows,
  onHost,
  plain,
  strings,
  text,
  withFacts,
  type LiveSource,
} from "./live";
import type { RawImportedJob } from "./types";

/**
 * Remotive public API. Terms: link to the Remotive page and name Remotive;
 * never pass the jobs to Google Jobs (D211); at most 4 requests a day.
 */
export const REMOTIVE_JOBS_URL = "https://remotive.com/api/remote-jobs";

const CATEGORIES: Record<string, string> = {
  "software development": "engineering",
  "devops / sysadmin": "engineering",
  qa: "engineering",
  design: "design",
  product: "product",
  "data analysis": "data",
  "data science": "data",
  marketing: "marketing",
  sales: "sales",
  "sales / business": "sales",
  "customer service": "support",
  "finance / legal": "finance",
  "human resources": "hr",
  writing: "content",
};

/** One API row into the import shape. The apply link is the Remotive page. */
export function mapRemotiveJob(
  row: Record<string, unknown>,
): RawImportedJob | null {
  const url = text(row.url);
  const title = text(row.title);
  const companyName = text(row.company_name);
  const id = idOf(row.id);
  if (!onHost(url, ["remotive.com"]) || !title || !companyName || !id) {
    return null;
  }
  const location = text(row.candidate_required_location);
  return {
    externalId: id,
    companyName,
    companyDomain: null,
    title,
    description:
      withFacts(plain(text(row.description)), [
        text(row.salary),
        location ? `Location: ${location}` : null,
      ]) || title,
    category: CATEGORIES[text(row.category).toLowerCase()] ?? "",
    employmentType: employment(text(row.job_type)),
    timeZone: null,
    skills: strings(row.tags),
    applyUrl: url,
    expiresAt: null,
  };
}

export const remotiveSource: LiveSource = {
  sourceName: "Remotive",
  kind: "api",
  url: REMOTIVE_JOBS_URL,
  minIntervalMs: hours(6),
  newPerRun: 15,
  staleAfterMs: LIVE_STALE_AFTER_MS,
  feed: "window",
  async fetch(fetchImpl) {
    const body = (await fetchJson(REMOTIVE_JOBS_URL, fetchImpl)) as {
      jobs?: unknown;
    };
    return mapRows(body.jobs, mapRemotiveJob);
  },
};
