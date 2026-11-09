import { describe, expect, it } from "vitest";
import { matchesScamPattern } from "../../../config/scam-patterns";
import { resolveTimeZone } from "../../../lib/tz-aliases";
import { apiFixtureAdapter, parseFixtureApi } from "../adapters/api-fixture";
import { parseFixtureRss, rssFixtureAdapter } from "../adapters/rss-fixture";
import type { RawImportedJob } from "../adapters/types";
import {
  dedupeKey,
  pickDuplicate,
  type DuplicateCandidate,
} from "../service/dedup";
import { normalizeImportedJob } from "../service/normalize";
import { decideOutcome, isMissingEverywhere } from "../service/outcome";

const now = new Date("2026-10-01T00:00:00Z");
const knownSkills: Record<string, string> = {
  TypeScript: "skill-ts",
  PostgreSQL: "skill-pg",
  Figma: "skill-figma",
};
const resolveSkill = async (value: string) => knownSkills[value] ?? null;

function raw(overrides: Partial<RawImportedJob> = {}): RawImportedJob {
  return {
    externalId: " ext-1 ",
    companyName: "  Northstar   Widgets ",
    companyDomain: "Northstar.INVALID",
    title: " Backend   Engineer ",
    description: "Build synthetic services.",
    category: "engineering",
    employmentType: "full_time",
    timeZone: null,
    skills: ["TypeScript", "Imaginary Brushwork", "TypeScript"],
    applyUrl: "https://northstar.invalid/jobs/backend",
    expiresAt: "2099-12-31",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<DuplicateCandidate> = {},
): DuplicateCandidate {
  return {
    jobId: "job-1",
    source: "imported",
    title: "Backend Engineer",
    location: null,
    companyName: "Northstar Widgets",
    companyDomain: "northstar.invalid",
    titleSimilarity: 1,
    descriptionSimilarity: 1,
    ...overrides,
  };
}

describe("fixture adapters", () => {
  it("parses both fixture sources with the scenarios 8A relies on", async () => {
    const api = await apiFixtureAdapter.loadFixture();
    const rss = await rssFixtureAdapter.loadFixture();
    expect(api.length).toBeGreaterThanOrEqual(6);
    expect(rss.length).toBeGreaterThanOrEqual(5);
    const apiTitle = api.find((job) => job.externalId === "api-001")?.title;
    const rssTitle = rss.find((job) => job.externalId === "rss-001")?.title;
    expect(apiTitle).toBe(rssTitle);
    expect(api.find((job) => job.externalId === "api-004")?.timeZone).toBe(
      "CET",
    );
    expect(rss.find((job) => job.externalId === "rss-005")?.timeZone).toBe(
      "MSK",
    );
  });

  it("decodes XML entities and treats missing optional fields as null", () => {
    const [job] = parseFixtureRss(
      `<rss><item><guid>g1</guid><company>A &amp; B</company><title>Ops &lt;Lead&gt;</title><description>d</description><category>operations</category><skills>SQL, ,Go</skills><link>https://a.invalid</link></item></rss>`,
    );
    expect(job).toMatchObject({
      companyName: "A & B",
      title: "Ops <Lead>",
      companyDomain: null,
      employmentType: null,
      timeZone: null,
      expiresAt: null,
      skills: ["SQL", "Go"],
    });
  });

  it("reads the API shape field by field", () => {
    const [job] = parseFixtureApi(
      JSON.stringify([
        {
          id: "x",
          company: "C",
          title: "T",
          description: "D",
          category: "data",
          skills: ["SQL"],
          apply: "https://c.invalid",
        },
      ]),
    );
    expect(job).toMatchObject({
      externalId: "x",
      companyDomain: null,
      employmentType: null,
      timeZone: null,
      expiresAt: null,
    });
  });
});

describe("time zone aliases", () => {
  it("resolves IANA names and unambiguous aliases only", () => {
    expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveTimeZone("cet")).toBe("Europe/Paris");
    expect(resolveTimeZone("MSK")).toBe("Europe/Moscow");
    expect(resolveTimeZone("IST")).toBeNull();
    expect(resolveTimeZone("EST")).toBeNull();
    expect(resolveTimeZone("UTC")).toBe("UTC");
    expect(resolveTimeZone("Etc/GMT-3")).toBeNull();
    expect(resolveTimeZone("GMT+3")).toBeNull();
    expect(resolveTimeZone("UTC+03:00")).toBeNull();
    expect(resolveTimeZone("  ")).toBeNull();
    expect(resolveTimeZone(null)).toBeNull();
  });
});

describe("normalizeImportedJob", () => {
  it("squashes text, lowercases the domain and keeps only catalog skills", async () => {
    const job = await normalizeImportedJob(
      raw(),
      resolveSkill,
      now,
      () => false,
    );
    expect(job).toMatchObject({
      externalId: "ext-1",
      companyName: "Northstar Widgets",
      companyDomain: "northstar.invalid",
      title: "Backend Engineer",
      skillIds: ["skill-ts"],
      workFormat: "remote",
      location: null,
      expired: false,
      scam: false,
    });
  });

  it("falls back for unknown category and employment type", async () => {
    const job = await normalizeImportedJob(
      raw({ category: "astrology", employmentType: "gig" }),
      resolveSkill,
      now,
      () => false,
    );
    expect(job.category).toBe("operations");
    expect(job.employmentType).toBe("full_time");
  });

  it("maps time zones through the alias table and rejects offsets", async () => {
    const cet = await normalizeImportedJob(
      raw({ timeZone: "CET" }),
      resolveSkill,
      now,
      () => false,
    );
    const offset = await normalizeImportedJob(
      raw({ timeZone: "GMT+3" }),
      resolveSkill,
      now,
      () => false,
    );
    expect(cet.timeZone).toBe("Europe/Paris");
    expect(offset.timeZone).toBeNull();
  });

  it("marks past expiry dates as expired", async () => {
    const job = await normalizeImportedJob(
      raw({ expiresAt: "2020-01-01" }),
      resolveSkill,
      now,
      () => false,
    );
    expect(job.expired).toBe(true);
  });

  it("drops an apply link that is not http or https and rejects the job", async () => {
    const job = await normalizeImportedJob(
      raw({ applyUrl: "javascript:alert(1)" }),
      resolveSkill,
      now,
      () => false,
    );
    expect(job.scam).toBe(true);
    expect(job.applyUrl).toBe("");
  });

  it("runs the scam check over title, description and apply URL", async () => {
    const shortened = await normalizeImportedJob(
      raw({ applyUrl: "https://bit.ly/abc" }),
      resolveSkill,
      now,
      matchesScamPattern,
    );
    const deposit = await normalizeImportedJob(
      raw({ description: "Pay a required crypto deposit to start." }),
      resolveSkill,
      now,
      matchesScamPattern,
    );
    const clean = await normalizeImportedJob(
      raw(),
      resolveSkill,
      now,
      matchesScamPattern,
    );
    expect(shortened.scam).toBe(true);
    expect(deposit.scam).toBe(true);
    expect(clean.scam).toBe(false);
  });
});

describe("dedup", () => {
  it("builds the 13.3 key from title, domain or name, and location", () => {
    expect(
      dedupeKey({
        title: "Báckend  Engineer!",
        companyDomain: null,
        companyName: "Northstar Widgets",
        location: null,
      }),
    ).toBe("backend engineer|northstar widgets|remote");
  });

  it("matches on the key even when similarity is low", () => {
    const incoming = candidate();
    expect(
      pickDuplicate(incoming, [
        candidate({ titleSimilarity: 0.1, descriptionSimilarity: 0.1 }),
      ]),
    ).not.toBeNull();
  });

  it("matches near duplicates only when both similarities pass", () => {
    const incoming = candidate({ title: "Backend Platform Engineer" });
    expect(
      pickDuplicate(incoming, [
        candidate({ titleSimilarity: 0.9, descriptionSimilarity: 0.85 }),
      ]),
    ).not.toBeNull();
    expect(
      pickDuplicate(incoming, [
        candidate({ titleSimilarity: 0.9, descriptionSimilarity: 0.5 }),
      ]),
    ).toBeNull();
    expect(
      pickDuplicate(incoming, [
        candidate({ titleSimilarity: 0.6, descriptionSimilarity: 0.95 }),
      ]),
    ).toBeNull();
  });

  it("prefers an internal duplicate over an imported one", () => {
    const picked = pickDuplicate(candidate(), [
      candidate({ jobId: "imported" }),
      candidate({ jobId: "internal", source: "internal" }),
    ]);
    expect(picked?.jobId).toBe("internal");
  });
});

describe("decideOutcome", () => {
  const base = {
    scam: false,
    expired: false,
    alreadyLinked: false,
    duplicate: null,
  } as const;

  it("rejects scams first and queues them for review", () => {
    expect(
      decideOutcome({
        ...base,
        scam: true,
        expired: true,
        duplicate: "internal",
      }),
    ).toMatchObject({
      status: "removed",
      counter: "rejected",
      queueForReview: true,
    });
  });

  it("hides duplicates of internal jobs without queueing", () => {
    expect(decideOutcome({ ...base, duplicate: "internal" })).toMatchObject({
      status: "removed",
      reason: "duplicate_of_internal",
      queueForReview: false,
    });
  });

  it("expires, updates, merges or creates", () => {
    expect(decideOutcome({ ...base, expired: true }).status).toBe("expired");
    expect(decideOutcome({ ...base, alreadyLinked: true }).counter).toBe(
      "updated",
    );
    expect(decideOutcome({ ...base, duplicate: "imported" }).counter).toBe(
      "merged",
    );
    expect(decideOutcome(base)).toMatchObject({
      status: "published",
      counter: "created",
    });
  });
});

describe("isMissingEverywhere", () => {
  it("needs one missed finished run for the current source", () => {
    expect(
      isMissingEverywhere([{ currentSource: true, finishedRunsSinceSeen: 0 }]),
    ).toBe(false);
    expect(
      isMissingEverywhere([{ currentSource: true, finishedRunsSinceSeen: 1 }]),
    ).toBe(true);
  });

  it("needs two missed runs from every other source of a merged job", () => {
    const current = { currentSource: true, finishedRunsSinceSeen: 1 };
    expect(
      isMissingEverywhere([
        current,
        { currentSource: false, finishedRunsSinceSeen: 1 },
      ]),
    ).toBe(false);
    expect(
      isMissingEverywhere([
        current,
        { currentSource: false, finishedRunsSinceSeen: 2 },
      ]),
    ).toBe(true);
    expect(isMissingEverywhere([])).toBe(false);
  });
});
