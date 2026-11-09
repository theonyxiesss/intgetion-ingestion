import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { jobs } from "@intgetion/jobs/db";

export const importSources = pgTable("import_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull(),
  url: text("url"),
  enabled: boolean("enabled").notNull().default(false),
  republishAllowed: boolean("republish_allowed").notNull().default(false),
  config: jsonb("config").notNull().default({}),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"),
});

/**
 * One row per (source, external id). A merged job has a row for every
 * source that carries it (13.3); exactly one row per job is primary and is
 * what public pages show as `source` (D71).
 */
export const jobSources = pgTable(
  "job_sources",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    importSourceId: uuid("import_source_id")
      .notNull()
      .references(() => importSources.id),
    externalId: text("external_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.importSourceId, table.externalId] }),
    index("job_sources_job_idx").on(table.jobId),
    uniqueIndex("job_sources_primary_idx")
      .on(table.jobId)
      .where(sql`${table.isPrimary}`),
  ],
);


export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => importSources.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    fetched: integer("fetched").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    merged: integer("merged").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    expired: integer("expired").notNull().default(0),
    error: text("error"),
  },
  (table) => [
    index("import_runs_source_started_idx").on(table.sourceId, table.startedAt),
    index("import_runs_retention_idx").on(table.finishedAt),
  ],
);

/**
 * Read only: the columns ingestion reads for duplicate checks. Jobs come from
 * the jobs package; companies belong to the companies module.
 */
export { jobs } from "@intgetion/jobs/db";
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  domain: text("domain"),
  origin: text("origin").notNull(),
});
