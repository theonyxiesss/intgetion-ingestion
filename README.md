# intgetion-ingestion

Job import of the INTGETION platform as a standalone service: live sources
(Remotive, RemoteOK, Jobicy, Himalayas and company boards) and the fictional
fixture sources, normalizing records, the scam pattern check, duplicate
merging with jobs already on the site, imported jobs and their source links,
expiry when every source has missed a job twice, the run ledger with stale
run recovery, and the external apply link (D18, D71–D75, 13.x). Not
connected to the platform yet; it is integrated later through a separate
branch and PR. The admin import page stays in the platform.

- Package `@intgetion/ingestion`, HTTP service on port `4210`.
- Depends by git tag on `@intgetion/kit` v0.3.1, `@intgetion/jobs` v0.1.2
  (types, `./db`), `@intgetion/taxonomy` v0.3.0 (catalog markers, types) and
  `@intgetion/companies` v0.1.1 (`publicHttpUrl`).
- Owns `import_sources`, `import_runs` and `job_sources` (migration
  `0001_ingestion.sql`, the final state of platform migrations 0007 and 0008
  for them, with the `app_rw` grants). `./db` exports their definitions; the
  run ledger is exported for other importers (events).
- Reads only, outside its tables: `jobs` and `companies` for duplicate
  candidates (with `skill_similarity`, the taxonomy function on `pg_trgm`).
- Fixture records live in `fixtures/import/`. Fixtures run only on a local
  database (`FIXTURES_NEED_LOCAL_DATABASE`).

## Ports (`src/ports.ts`)

- jobs: `saveImportedJob`, `expireImportedJobs`, `getJobForPublic`;
- taxonomy: `normalizeSkill`;
- companies: `findOrCreateImportedCompany(name, domain)` → `{ id }` — the
  imported company with this domain, else a very similar name, else a new
  unverified one; internal companies are never matched. It was ingestion code
  on the platform; at integration the companies module takes it over (the
  test support keeps the reference version);
- feedback: `recordAppliedExternal` (once per person and job);
- moderation: `queueRejectedImport` (one pending item per job).

Over HTTP feedback and moderation are called on their services
(`/v1/events/applied-external`, `/v1/queue` with `once`); jobs, taxonomy and
the imported company go to the platform callback
`POST /api/internal/ingestion/:op` with `{args}`.

## HTTP

Every route except `/health` needs `authorization: Bearer $INGESTION_SERVICE_TOKEN`.

| Method | Path | Does |
| --- | --- | --- |
| POST | `/v1/tasks/import` | cron: one import pass (live with `IMPORT_LIVE_ENABLED=true`, else fixtures) |
| POST | `/v1/jobs/:id/apply-external` | the external link; the person (if any) in `x-user-id` |
| GET | `/v1/admin/runs`, `/v1/admin/sources` | admin lists; the platform checks `import.manage` |

## Run

```bash
cp .env.example .env
npm ci
npm run migrate
npm start
```

## Tests

Unit tests run without a database (live adapters on recorded payloads, no
network). Integration tests run when `DATABASE_URL` is set, on a database
prepared as in CI: `test/sql/pre/*.sql` (the platform stub, companies, the
jobs module's migration and the moderation module's migration), then
`npm run migrate`. They run the import end to end against the jobs module's
real functions. The rule that imported jobs and companies are read-only for
employers is tested in the jobs and companies modules.
