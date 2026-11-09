import {
  LIVE_STALE_AFTER_MS,
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
 * Remote OK public API. Terms (first element of the response): link back to
 * the Remote OK page with a followed link and name Remote OK. Our apply link
 * has no nofollow (ExternalApplyLink).
 */
export const REMOTEOK_JOBS_URL = "https://remoteok.com/api";

export function mapRemoteOkJob(
  row: Record<string, unknown>,
): RawImportedJob | null {
  const url = text(row.url);
  const title = text(row.position);
  const companyName = text(row.company);
  const id = idOf(row.id);
  if (
    !onHost(url, ["remoteok.com", "www.remoteok.com"]) ||
    !title ||
    !companyName ||
    !id
  ) {
    return null;
  }
  const tags = strings(row.tags);
  const location = text(row.location);
  return {
    externalId: id,
    companyName,
    companyDomain: null,
    title,
    description:
      withFacts(plain(text(row.description)), [
        salaryLine(row.salary_min, row.salary_max, "USD", "year"),
        location ? `Location: ${location}` : null,
      ]) || title,
    category: "",
    employmentType: tags.some((tag) => tag.toLowerCase() === "part time")
      ? "part_time"
      : null,
    timeZone: null,
    skills: tags,
    applyUrl: url,
    expiresAt: null,
  };
}

export const remoteOkSource: LiveSource = {
  sourceName: "Remote OK",
  kind: "api",
  url: REMOTEOK_JOBS_URL,
  minIntervalMs: hours(6),
  newPerRun: 15,
  staleAfterMs: LIVE_STALE_AFTER_MS,
  feed: "window",
  async fetch(fetchImpl) {
    // The first element is the legal notice; it has no url and is dropped.
    return mapRows(
      await fetchJson(REMOTEOK_JOBS_URL, fetchImpl),
      mapRemoteOkJob,
    );
  },
};
