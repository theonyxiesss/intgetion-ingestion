import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImportAdapter, RawImportedJob } from "./types";

type ApiFixtureRecord = {
  id: string;
  company: string;
  domain?: string;
  title: string;
  description: string;
  category: string;
  employment?: string;
  timezone?: string;
  skills?: string[];
  apply: string;
  expires?: string;
};

export function parseFixtureApi(json: string): RawImportedJob[] {
  const records = JSON.parse(json) as ApiFixtureRecord[];
  return records.map((row) => ({
    externalId: row.id,
    companyName: row.company,
    companyDomain: row.domain ?? null,
    title: row.title,
    description: row.description,
    category: row.category,
    employmentType: row.employment ?? null,
    timeZone: row.timezone ?? null,
    skills: row.skills ?? [],
    applyUrl: row.apply,
    expiresAt: row.expires ?? null,
  }));
}

export const apiFixtureAdapter: ImportAdapter = {
  sourceName: "Fictional API Feed",
  kind: "api",
  async loadFixture() {
    const path = join(process.cwd(), "fixtures/import/fictional-api/jobs.json");
    return parseFixtureApi(await readFile(path, "utf8"));
  },
};
