import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImportAdapter, RawImportedJob } from "./types";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function field(item: string, name: string): string {
  const match = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  const value = match?.[1]?.trim() ?? "";
  return value.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (entity) => ENTITIES[entity]!,
  );
}

/** Reads the fixture feed's item fields; this is not a general RSS parser. */
export function parseFixtureRss(xml: string): RawImportedJob[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(
    ([, item = ""]) => ({
      externalId: field(item, "guid"),
      companyName: field(item, "company"),
      companyDomain: field(item, "domain") || null,
      title: field(item, "title"),
      description: field(item, "description"),
      category: field(item, "category"),
      employmentType: field(item, "employment") || null,
      timeZone: field(item, "timezone") || null,
      skills: field(item, "skills")
        .split(",")
        .map((skill) => skill.trim())
        .filter(Boolean),
      applyUrl: field(item, "link"),
      expiresAt: field(item, "expires") || null,
    }),
  );
}

export const rssFixtureAdapter: ImportAdapter = {
  sourceName: "Fictional RSS Feed",
  kind: "rss",
  async loadFixture() {
    const path = join(process.cwd(), "fixtures/import/fictional-rss/feed.xml");
    return parseFixtureRss(await readFile(path, "utf8"));
  },
};
