import {
  LIVE_STALE_AFTER_MS,
  employment,
  fetchJson,
  hours,
  idOf,
  mapRows,
  onHost,
  plain,
  salaryLine,
  strings,
  text,
  withFacts,
  type LiveSource,
} from "./live";
import type { RawImportedJob } from "./types";

/**
 * Jobicy public API. Terms: keep Jobicy as the source with its job URL, do
 * not present the jobs as our own; poll a few times a day at most.
 */
export const JOBICY_JOBS_URL =
  "https://jobicy.com/api/v2/remote-jobs?count=100";

const CATEGORIES: Record<string, string> = {
  programming: "engineering",
  "dev & engineering": "engineering",
  "technical support": "support",
  "data science & analytics": "data",
  "design & multimedia": "design",
  "product & operations": "product",
  "marketing & sales": "marketing",
  "seo & smm": "marketing",
  sales: "sales",
  "customer success": "support",
  "accounting & finance": "finance",
  "hr & recruiting": "hr",
  legal: "legal",
  "copywriting & content": "content",
  "admin & operations": "operations",
};

export function mapJobicyJob(
  row: Record<string, unknown>,
): RawImportedJob | null {
  const url = text(row.url);
  const title = text(row.jobTitle);
  const companyName = text(row.companyName);
  const id = idOf(row.id);
  if (!onHost(url, ["jobicy.com"]) || !title || !companyName || !id) {
    return null;
  }
  const industry = strings(row.jobIndustry)[0]?.toLowerCase() ?? "";
  const geo = text(row.jobGeo);
  return {
    externalId: id,
    companyName,
    companyDomain: null,
    title,
    description:
      withFacts(plain(text(row.jobDescription)), [
        salaryLine(
          row.salaryMin,
          row.salaryMax,
          text(row.salaryCurrency),
          text(row.salaryPeriod),
        ),
        geo && geo.toLowerCase() !== "anywhere" ? `Location: ${geo}` : null,
      ]) || title,
    category: CATEGORIES[industry] ?? "",
    employmentType: employment(strings(row.jobType)[0] ?? ""),
    timeZone: null,
    skills: [],
    applyUrl: url,
    expiresAt: null,
  };
}

export const jobicySource: LiveSource = {
  sourceName: "Jobicy",
  kind: "api",
  url: JOBICY_JOBS_URL,
  minIntervalMs: hours(6),
  newPerRun: 15,
  staleAfterMs: LIVE_STALE_AFTER_MS,
  feed: "window",
  async fetch(fetchImpl) {
    const body = (await fetchJson(JOBICY_JOBS_URL, fetchImpl)) as {
      jobs?: unknown;
    };
    return mapRows(body.jobs, mapJobicyJob);
  },
};
