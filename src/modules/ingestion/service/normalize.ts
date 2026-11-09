import {
  EMPLOYMENT_TYPES,
  inferImportedMarkers,
  JOB_CATEGORIES,
  type EmploymentType,
  type JobCategory,
  type Sector,
  type Seniority,
} from "@intgetion/taxonomy/catalog";
import { publicHttpUrl } from "@intgetion/companies";
import { resolveTimeZone } from "../../../lib/tz-aliases";
import type { RawImportedJob } from "../adapters/types";

export { JOB_CATEGORIES };
export type { EmploymentType, JobCategory };

export type NormalizedImportedJob = Omit<
  RawImportedJob,
  | "skills"
  | "category"
  | "employmentType"
  | "timeZone"
  | "workFormat"
  | "location"
  | "countries"
> & {
  category: JobCategory;
  employmentType: EmploymentType;
  timeZone: string | null;
  skillIds: string[];
  sectors: Sector[];
  seniority: Seniority | null;
  location: string | null;
  workFormat: "remote" | "hybrid" | "onsite";
  countries: string[];
  expired: boolean;
  scam: boolean;
};

/** Canonical skill id, or null when the text went to skill_suggestions. */
export type SkillResolver = (value: string) => Promise<string | null>;

const squash = (value: string) => value.trim().replace(/\s+/g, " ");

/**
 * Like `squash`, but keeps line breaks, list indents and blank lines, so
 * the Markdown of a description survives (D591).
 */
const squashLines = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const indent = line.match(/^[ \t]*/)?.[0].replace(/\t/g, "  ") ?? "";
      const body = line.trim().replace(/\s+/g, " ");
      return body ? indent + body : "";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * D416: place only as the source states it. An office or hybrid job
 * without a place is published as remote: the database needs a location
 * for those, and we do not invent one.
 */
function place(raw: RawImportedJob) {
  const countries = [
    ...new Set(
      (raw.countries ?? [])
        .map((code) => code.trim().toUpperCase())
        .filter((code) => /^[A-Z]{2}$/.test(code)),
    ),
  ].slice(0, 10);
  const location = raw.location ? squash(raw.location).slice(0, 200) : "";
  const workFormat: "remote" | "hybrid" | "onsite" =
    raw.workFormat && raw.workFormat !== "remote" && location
      ? raw.workFormat
      : "remote";
  return { workFormat, location: location || null, countries };
}

/**
 * 13.2: skills to the catalog (unknown ones are not stored on the job),
 * IANA zone or null, fixed category and employment sets. Salary is not in
 * the fixtures; without one the salary component stays neutral (D4/D5).
 */
export async function normalizeImportedJob(
  raw: RawImportedJob,
  resolveSkill: SkillResolver,
  now: Date,
  isScam: (text: string) => boolean,
): Promise<NormalizedImportedJob> {
  const skillIds: string[] = [];
  for (const skill of raw.skills) {
    const id = await resolveSkill(skill);
    if (id && !skillIds.includes(id)) skillIds.push(id);
  }
  const title = squash(raw.title);
  const description = squashLines(raw.description);
  const markers = inferImportedMarkers(
    `${title}\n${description}\n${raw.category}`,
  );
  const category = (JOB_CATEGORIES as readonly string[]).includes(raw.category)
    ? (raw.category as JobCategory)
    : (markers.category ?? "operations");
  const employmentType = (EMPLOYMENT_TYPES as readonly string[]).includes(
    raw.employmentType ?? "",
  )
    ? (raw.employmentType as EmploymentType)
    : "full_time";
  const trimmedApplyUrl = raw.applyUrl.trim();
  const applyUrl = publicHttpUrl(trimmedApplyUrl) ?? "";
  const unsafeApplyUrl = trimmedApplyUrl.length > 0 && applyUrl.length === 0;
  return {
    externalId: raw.externalId.trim(),
    companyName: squash(raw.companyName),
    companyDomain: raw.companyDomain?.trim().toLowerCase() || null,
    title,
    description,
    category,
    employmentType,
    timeZone: resolveTimeZone(raw.timeZone),
    skillIds,
    sectors: markers.sectors,
    seniority: markers.seniority,
    applyUrl,
    expiresAt: raw.expiresAt,
    ...place(raw),
    expired: Boolean(
      raw.expiresAt && Date.parse(raw.expiresAt) < now.getTime(),
    ),
    // The apply link counts too: link shorteners are a scam signal (13.4).
    scam:
      unsafeApplyUrl || isScam(`${title}\n${description}\n${trimmedApplyUrl}`),
  };
}
