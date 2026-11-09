import {
  LIVE_STALE_AFTER_MS,
  employment,
  fetchJson,
  hours,
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
 * Himalayas public API. Terms: link to the Himalayas page and name
 * Himalayas; never pass the jobs to Google Jobs or other boards; data
 * refreshes daily; at most 20 jobs a request.
 */
export const HIMALAYAS_JOBS_URL = "https://himalayas.app/jobs/api";
const PAGE_SIZE = 20;
const PAGES = 5;

const CATEGORIES: Record<string, string> = {
  engineering: "engineering",
  "software development": "engineering",
  "data science": "data",
  data: "data",
  design: "design",
  product: "product",
  growth: "marketing",
  marketing: "marketing",
  sales: "sales",
  "customer success": "support",
  "customer support": "support",
  operations: "operations",
  finance: "finance",
  "people & hr": "hr",
  legal: "legal",
  writing: "content",
};

function isoFromEpoch(value: unknown): string | null {
  return typeof value === "number" && value > 0
    ? new Date(value * 1000).toISOString()
    : null;
}

export function mapHimalayasJob(
  row: Record<string, unknown>,
): RawImportedJob | null {
  const url = text(row.applicationLink) || text(row.guid);
  const title = text(row.title);
  const companyName = text(row.companyName);
  if (!onHost(url, ["himalayas.app"]) || !title || !companyName) return null;
  const parent = strings(row.parentCategories)[0]?.toLowerCase() ?? "";
  const where = strings(row.locationRestrictions).join(", ");
  return {
    // The job page is stable and unique; the API has no numeric id.
    externalId: text(row.guid) || url,
    companyName,
    companyDomain: null,
    title,
    description:
      withFacts(plain(text(row.description)), [
        salaryLine(
          row.minSalary,
          row.maxSalary,
          text(row.currency),
          text(row.salaryPeriod),
        ),
        where ? `Location: ${where}` : null,
      ]) || title,
    category: CATEGORIES[parent] ?? "",
    employmentType: employment(text(row.employmentType)),
    timeZone: null,
    skills: strings(row.categories).map((tag) => tag.replace(/-/g, " ")),
    applyUrl: url,
    expiresAt: isoFromEpoch(row.expiryDate),
  };
}

export const himalayasSource: LiveSource = {
  sourceName: "Himalayas",
  kind: "api",
  url: HIMALAYAS_JOBS_URL,
  minIntervalMs: hours(6),
  newPerRun: 15,
  staleAfterMs: LIVE_STALE_AFTER_MS,
  feed: "window",
  async fetch(fetchImpl) {
    const jobs: RawImportedJob[] = [];
    for (let page = 0; page < PAGES; page += 1) {
      const body = (await fetchJson(
        `${HIMALAYAS_JOBS_URL}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
        fetchImpl,
      )) as { jobs?: unknown };
      const mapped = mapRows(body.jobs, mapHimalayasJob);
      if (!Array.isArray(body.jobs) || body.jobs.length === 0) break;
      jobs.push(...mapped);
    }
    return jobs;
  },
};
