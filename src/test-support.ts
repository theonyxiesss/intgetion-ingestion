import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@intgetion/kit";
import { expireImportedJobs, getJobForPublic, saveImportedJob, setJobsPorts } from "@intgetion/jobs";
import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { setIngestionPorts, type IngestionPorts } from "./ports";

/** The companies columns the import touches (companies module table). */
const companiesTable = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  domain: text("domain"),
  origin: text("origin").notNull(),
  status: text("status").notNull(),
  isTrusted: boolean("is_trusted").notNull(),
});

/** Name similarity at which an imported company counts as the same one. */
const COMPANY_NAME_SIMILARITY = 0.9;

/**
 * The platform's way to find or create an imported company, against the same
 * database (the companies module takes it over at integration).
 */
async function findOrCreateImportedCompany(name: string, domain: string | null) {
  const db = getDb();
  if (domain) {
    const [byDomain] = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(and(eq(companiesTable.origin, "imported"), eq(companiesTable.domain, domain)))
      .limit(1);
    if (byDomain) return byDomain;
  }
  const [byName] = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(
      and(
        eq(companiesTable.origin, "imported"),
        sql`public.skill_similarity(${companiesTable.name}, ${name}) >= ${COMPANY_NAME_SIMILARITY}`,
      ),
    )
    .orderBy(desc(sql`public.skill_similarity(${companiesTable.name}, ${name})`))
    .limit(1);
  if (byName) return byName;
  const baseSlug =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 54) || "imported-company";
  const [created] = await db
    .insert(companiesTable)
    .values({
      name,
      slug: `${baseSlug}-${randomUUID().slice(0, 8)}`,
      domain,
      origin: "imported",
      status: "unverified",
      isTrusted: false,
    })
    .returning({ id: companiesTable.id });
  if (!created) throw new Error("Could not create imported company");
  return created;
}

/** The moderation module's "queue once" for a rejected import, same database. */
async function queueRejectedImport(jobId: string, reason: string) {
  await getDb().execute(sql`
    insert into public.moderation_queue (entity_type, entity_id, reason, risk_flags)
    select 'job', ${jobId}, ${reason}, ${JSON.stringify([reason])}::jsonb
    where not exists (
      select 1 from public.moderation_queue
      where entity_type = 'job' and entity_id = ${jobId} and status = 'pending'
    )
  `);
}

/**
 * In-process ports for integration tests: the jobs module's real functions
 * and the companies and moderation steps on the same database.
 */
export function useDbPorts(overrides: Partial<IngestionPorts> = {}): void {
  // Public reads of the jobs module ask its own ports only for signed-in viewers.
  setJobsPorts({
    promotedHireJobIds: async () => [],
    findMemberRole: async () => null,
  } as never);
  setIngestionPorts({
    jobs: { saveImportedJob, expireImportedJobs, getJobForPublic },
    taxonomy: { normalizeSkill: (async () => ({ status: "empty" })) as never },
    findOrCreateImportedCompany,
    queueRejectedImport,
    recordAppliedExternal: async () => {},
    ...overrides,
  });
}
