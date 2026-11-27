import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@intgetion/kit";
import { useDbPorts } from "../../test-support";
import * as repo from "./repo/import-repo";

const token = randomUUID().slice(0, 8);
const domain = `checks-${token}.invalid`;
const companyId = randomUUID();
const jobId = randomUUID();
const sourceId = randomUUID();

async function insertSource(externalId: string, result: string) {
  await getDb().execute(sql`
    insert into public.job_sources(job_id, import_source_id, external_id, source_url, is_primary, last_checked_at, last_check_result, last_check_note)
    values (${jobId}, ${sourceId}, ${externalId}, ${`https://${domain}/${externalId}`}, false, now(), ${result}, '404')
  `);
}

// Guards every suite in this file: nothing is seeded unless the database is
// on loopback. A module-level throw fails the file before any beforeAll runs.
{
  const dbUrl = process.env.DATABASE_URL;
  if (
    !dbUrl ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(dbUrl).hostname)
  ) {
    throw new Error("source check integration tests require a loopback database");
  }
}

describe("job source liveness check columns", () => {
  beforeAll(async () => {
    useDbPorts();
    const db = getDb();
    await db.execute(
      sql`insert into public.companies(id,name,slug,domain,status) values (${companyId},${`Checks Corp ${token}`},${`checks-${token}`},${domain},'verified')`,
    );
    await db.execute(sql`insert into public.jobs(id,company_id,title,description,category,work_format,employment_type,application_method,status,published_at,expires_at) values
      (${jobId},${companyId},${`Checked Role ${token}`},${"Maintain synthetic services with a small remote team, long enough text."},'engineering','remote','full_time','internal','published',now(),now()+interval '30 days')`);
    await db.execute(
      sql`insert into public.import_sources(id,name,kind) values (${sourceId},${`Checks Source ${token}`},'api')`,
    );
  });

  afterAll(async () => {
    const db = getDb();
    await db.execute(sql`delete from public.companies where id = ${companyId}`);
    await db.execute(sql`delete from public.import_sources where id = ${sourceId}`);
  });

  it("rejects an unknown last_check_result", async () => {
    await expect(insertSource("bad", "gone")).rejects.toThrow();
  });

  it("accepts live, closed and unknown", async () => {
    // Only one primary per job; these rows are non-primary.
    await insertSource("ok-closed", "closed");
    await insertSource("ok-live", "live");
    await insertSource("ok-unknown", "unknown");
    const rows = await getDb().execute<{ last_check_result: string }>(
      sql`select last_check_result from public.job_sources where import_source_id = ${sourceId} order by external_id`,
    );
    expect(rows.map((r) => r.last_check_result)).toEqual(["closed", "live", "unknown"]);
  });

  it("defaults the check columns to null for new rows", async () => {
    await getDb().execute(sql`
      insert into public.job_sources(job_id, import_source_id, external_id, source_url, is_primary)
      values (${jobId}, ${sourceId}, 'fresh', ${`https://${domain}/fresh`}, false)
    `);
    const rows = await getDb().execute<{
      last_checked_at: Date | null;
      last_check_result: string | null;
      last_check_note: string | null;
    }>(
      sql`select last_checked_at, last_check_result, last_check_note from public.job_sources where external_id = 'fresh' and import_source_id = ${sourceId}`,
    );
    expect(rows[0]).toEqual({
      last_checked_at: null,
      last_check_result: null,
      last_check_note: null,
    });
  });

  it("re-applies the migration without errors", async () => {
    const text = await readFile(
      join(import.meta.dirname, "..", "..", "..", "migrations", "0002_source_checks.sql"),
      "utf8",
    );
    // The same way scripts/migrate.ts runs a file: raw client, simple protocol.
    const client = postgres(process.env.DATABASE_URL!, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await expect(client.unsafe(text)).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });
});

describe("liveness check queries", () => {
  const t = randomUUID().slice(0, 8);
  const dom = `queries-${t}.invalid`;
  const company = randomUUID();
  const jobA1 = randomUUID();
  const jobA2 = randomUUID();
  const jobPaused = randomUUID();
  const jobOther = randomUUID();
  const sourceB = randomUUID();
  const sourceC = randomUUID();
  const checkedAt = new Date(Date.now() - 2 * 3_600_000);

  async function insertJob(id: string, status: string) {
    await getDb().execute(sql`insert into public.jobs(id,company_id,title,description,category,work_format,employment_type,application_method,status,source,published_at,expires_at) values
      (${id},${company},${`Query Role ${t} ${id.slice(0, 4)}`},${"Maintain synthetic services with a small remote team, long enough text."},'engineering','remote','full_time','internal',${status}::public.job_status,'imported',now(),now()+interval '30 days')`);
  }
  async function insertRow(
    jobId: string,
    sourceId: string,
    externalId: string,
    lastCheckedAt: Date | null,
  ) {
    await getDb().execute(sql`
      insert into public.job_sources(job_id, import_source_id, external_id, source_url, is_primary, last_checked_at)
      values (${jobId}, ${sourceId}, ${externalId}, ${`https://${dom}/${externalId}`}, false, ${lastCheckedAt?.toISOString() ?? null}::timestamptz)
    `);
  }

  beforeAll(async () => {
    useDbPorts();
    const db = getDb();
    await db.execute(
      sql`insert into public.companies(id,name,slug,domain,status) values (${company},${`Query Corp ${t}`},${`query-${t}`},${dom},'verified')`,
    );
    await insertJob(jobA1, "published");
    await insertJob(jobA2, "published");
    await insertJob(jobPaused, "paused");
    await insertJob(jobOther, "published");
    await db.execute(
      sql`insert into public.import_sources(id,name,kind) values (${sourceB},${`Query B ${t}`},'api'), (${sourceC},${`Query C ${t}`},'api')`,
    );
    await insertRow(jobA1, sourceB, "a1", checkedAt);
    await insertRow(jobA2, sourceB, "a2", null);
    await insertRow(jobPaused, sourceB, "a3", null);
    await insertRow(jobOther, sourceC, "c1", null);
  });

  afterAll(async () => {
    const db = getDb();
    await db.execute(sql`delete from public.companies where id = ${company}`);
    await db.execute(
      sql`delete from public.import_sources where id in (${sourceB}, ${sourceC})`,
    );
  });

  it("dueWindowChecks: published rows of the given sources, never checked first", async () => {
    const due = await repo.dueWindowChecks([sourceB], 10);
    expect(due.map((row) => row.externalId)).toEqual(["a2", "a1"]);
    expect(due[0]).toMatchObject({ jobId: jobA2, sourceId: sourceB });
  });

  it("publishedSourceRows: only published jobs of the source", async () => {
    const rows = await repo.publishedSourceRows(sourceB);
    expect(rows.map((row) => row.externalId).sort()).toEqual(["a1", "a2"]);
  });

  it("latestSourceCheck returns a Date", async () => {
    const at = await repo.latestSourceCheck(sourceB);
    expect(at).toBeInstanceOf(Date);
    expect(at!.getTime()).toBe(checkedAt.getTime());
    expect(await repo.latestSourceCheck(sourceC)).toBeNull();
  });

  it("dueWindowStats: count, and no oldest while a row was never checked", async () => {
    expect(await repo.dueWindowStats([sourceB])).toEqual({
      count: 2,
      oldestCheckedAt: null,
    });
  });

  it("markChecked updates only the named rows of the source", async () => {
    const at = new Date();
    await repo.markChecked(sourceB, ["a2"], "unknown", "http_503", at);
    const rows = await getDb().execute<{
      external_id: string;
      last_checked_at: Date | null;
      last_check_result: string | null;
      last_check_note: string | null;
    }>(
      sql`select external_id, last_checked_at, last_check_result, last_check_note from public.job_sources where import_source_id in (${sourceB}, ${sourceC}) order by external_id`,
    );
    const byId = new Map(rows.map((row) => [row.external_id, row]));
    expect(byId.get("a2")).toMatchObject({
      last_check_result: "unknown",
      last_check_note: "http_503",
    });
    expect(new Date(byId.get("a2")!.last_checked_at!).getTime()).toBe(at.getTime());
    expect(byId.get("a1")?.last_check_result).toBeNull();
    expect(byId.get("c1")?.last_checked_at).toBeNull();
    expect(await repo.dueWindowStats([sourceB])).toEqual({
      count: 2,
      oldestCheckedAt: checkedAt,
    });
  });

  it("linkImportedSource on conflict clears the last check", async () => {
    await repo.markChecked(sourceB, ["a1"], "live", "http_200", new Date());
    await repo.linkImportedSource(jobA1, sourceB, "a1", `https://${dom}/a1`, new Date());
    const [row] = await getDb().execute<{
      last_checked_at: Date | null;
      last_check_result: string | null;
      last_check_note: string | null;
    }>(
      sql`select last_checked_at, last_check_result, last_check_note from public.job_sources where import_source_id = ${sourceB} and external_id = 'a1'`,
    );
    expect(row).toEqual({
      last_checked_at: null,
      last_check_result: null,
      last_check_note: null,
    });
  });
});
