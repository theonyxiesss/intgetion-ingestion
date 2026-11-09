import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@intgetion/kit";
import { matchesScamPattern } from "../../config/scam-patterns";
import { useDbPorts } from "../../test-support";
import type { ImportAdapter, RawImportedJob } from "./adapters/types";
import { applyExternal, runFixtureImports } from "./service";

const token = randomUUID().slice(0, 8);
const domain = `${token}.invalid`;
const internalDomain = `internal-${token}.invalid`;
const internalCompanyId = randomUUID();
const internalJobId = randomUUID();
const description =
  "Build synthetic account services and maintain fictional sample APIs with a small remote team.";

function record(overrides: Partial<RawImportedJob>): RawImportedJob {
  return {
    externalId: randomUUID(),
    companyName: `Integration Widgets ${token}`,
    companyDomain: domain,
    title: `Backend Engineer ${token}`,
    description,
    category: "engineering",
    employmentType: "full_time",
    timeZone: "CET",
    skills: [],
    applyUrl: `https://${domain}/jobs/backend`,
    expiresAt: "2099-12-31",
    ...overrides,
  };
}

const apiRecords = [
  record({ externalId: "api-main" }),
  record({
    externalId: "api-scam",
    title: `Training Associate ${token}`,
    description:
      "Pay a required crypto deposit to unlock guaranteed income. Long enough text for the schema.",
  }),
  record({
    externalId: "api-expired",
    title: `Data Analyst ${token}`,
    expiresAt: "2020-01-01",
  }),
  record({
    externalId: "api-internal-dup",
    companyName: `Internal Corp ${token}`,
    companyDomain: internalDomain,
    title: `Platform Lead ${token}`,
  }),
];
const rssRecords = [record({ externalId: "rss-main" })];

let apiFeed = apiRecords;
let rssFeed = rssRecords;
const apiAdapter: ImportAdapter = {
  sourceName: `Integration API ${token}`,
  kind: "api",
  loadFixture: async () => apiFeed,
};
const rssAdapter: ImportAdapter = {
  sourceName: `Integration RSS ${token}`,
  kind: "rss",
  loadFixture: async () => rssFeed,
};

const start = new Date();
const hours = (n: number) => new Date(start.getTime() + n * 60 * 60 * 1000);
const run = (at: Date) =>
  runFixtureImports({
    adapters: [apiAdapter, rssAdapter],
    resolveSkill: async () => null,
    isScam: matchesScamPattern,
    now: () => at,
  });

async function jobOf(externalId: string) {
  const rows = await getDb().execute<{
    id: string;
    company_id: string;
    status: string;
    source: string;
    application_url: string;
    timezone_required: string | null;
  }>(sql`
    select j.id, j.company_id, j.status, j.source, j.application_url, j.timezone_required
    from public.job_sources s join public.jobs j on j.id = s.job_id
    join public.import_sources i on i.id = s.import_source_id
    where s.external_id = ${externalId} and i.name in (${apiAdapter.sourceName}, ${rssAdapter.sourceName})
  `);
  return rows[0];
}

beforeAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (
    !dbUrl ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      new URL(dbUrl).hostname,
    )
  ) {
    throw new Error("8A integration tests require a loopback database");
  }
  useDbPorts();
  const db = getDb();
  await db.execute(
    sql`insert into public.companies(id,name,slug,domain,status) values (${internalCompanyId},${`Internal Corp ${token}`},${`internal-${token}`},${internalDomain},'verified')`,
  );
  await db.execute(sql`insert into public.jobs(id,company_id,title,description,category,work_format,employment_type,application_method,status,published_at,expires_at) values
    (${internalJobId},${internalCompanyId},${`Platform Lead ${token}`},${description},'engineering','remote','full_time','internal','published',now(),now()+interval '30 days')`);
});

afterAll(async () => {
  const db = getDb();
  await db.execute(sql`
    delete from public.moderation_queue where entity_id in (
      select s.job_id from public.job_sources s join public.import_sources i on i.id = s.import_source_id
      where i.name in (${apiAdapter.sourceName}, ${rssAdapter.sourceName}))
  `);
  await db.execute(
    sql`delete from public.companies where domain in (${domain}, ${internalDomain})`,
  );
  await db.execute(
    sql`delete from public.import_sources where name in (${apiAdapter.sourceName}, ${rssAdapter.sourceName})`,
  );
});

describe("fixture import database integration", () => {
  it("creates, rejects, expires and merges on the first run", async () => {
    const [api, rss] = await run(start);
    expect(api).toMatchObject({
      skipped: false,
      error: null,
      fetched: 4,
      created: 1,
      rejected: 2,
      expired: 1,
    });
    expect(rss).toMatchObject({ skipped: false, error: null, merged: 1 });

    const main = await jobOf("api-main");
    expect(main).toMatchObject({
      status: "published",
      source: "imported",
      timezone_required: "Europe/Paris",
    });
    expect((await jobOf("rss-main"))?.id).toBe(main?.id);
    expect((await jobOf("api-scam"))?.status).toBe("removed");
    expect((await jobOf("api-expired"))?.status).toBe("expired");
    expect((await jobOf("api-internal-dup"))?.status).toBe("removed");

    const db = getDb();
    const sources = await db.execute<{ is_primary: boolean }>(
      sql`select is_primary from public.job_sources where job_id = ${main!.id}`,
    );
    expect(sources.map((row) => row.is_primary).sort()).toEqual([false, true]);
    const queued = await db.execute(
      sql`select 1 from public.moderation_queue where entity_id = ${(await jobOf("api-scam"))!.id} and status = 'pending'`,
    );
    expect(queued).toHaveLength(1);
    const internal = await db.execute<{ status: string; source: string }>(
      sql`select status, source from public.jobs where id = ${internalJobId}`,
    );
    expect(internal[0]).toEqual({ status: "published", source: "internal" });
  });

  it("skips a source that already ran within the hour", async () => {
    const reports = await run(hours(0.5));
    expect(reports.every((report) => report.skipped)).toBe(true);
  });

  it("updates a record seen again instead of creating it", async () => {
    const [api] = await run(hours(2));
    expect(api).toMatchObject({ created: 0, updated: 1, rejected: 2 });
  });

  it("expires a merged job only after every source missed it twice", async () => {
    apiFeed = [];
    rssFeed = [];
    // First miss of both sources: nothing expires yet.
    const first = await run(hours(4));
    expect(first.map((report) => report.expired)).toEqual([0, 0]);
    expect((await jobOf("api-main"))?.status).toBe("published");
    // Second miss: the API source alone is not enough (RSS missed once),
    // the RSS run then sees both sources missing twice.
    const [api, rss] = await run(hours(6));
    expect(api?.expired).toBe(0);
    expect(rss?.expired).toBe(1);
    expect((await jobOf("api-main"))?.status).toBe("expired");
  });


  it("returns the external link only for a published imported job", async () => {
    apiFeed = apiRecords;
    rssFeed = rssRecords;
    await run(hours(10));
    const main = await jobOf("api-main");
    expect(main?.status).toBe("published");
    const recorded: string[] = [];
    await expect(
      applyExternal(main!.id, randomUUID(), async ({ jobId }) => {
        recorded.push(jobId);
      }),
    ).resolves.toEqual({ externalUrl: `https://${domain}/jobs/backend` });
    expect(recorded).toEqual([main!.id]);
    await expect(
      applyExternal((await jobOf("api-scam"))!.id, null),
    ).rejects.toMatchObject({ status: 404 });
    await expect(applyExternal(internalJobId, null)).rejects.toMatchObject({
      status: 404,
    });
  });
});
