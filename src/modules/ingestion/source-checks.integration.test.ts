import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@intgetion/kit";
import { useDbPorts } from "../../test-support";

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

describe("job source liveness check columns", () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (
      !dbUrl ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(dbUrl).hostname)
    ) {
      throw new Error("source check integration tests require a loopback database");
    }
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
    await expect(getDb().execute(sql.raw(text))).resolves.toBeDefined();
  });
});
