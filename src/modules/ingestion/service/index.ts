/**
 * Public service surface.
 * Other modules may import only this file, never this module's repo.
 */
export {
  FIXTURE_ADAPTERS,
  LIVE_SOURCES,
  runFixtureImport,
  runFixtureImports,
  runLiveImports,
} from "./ingest-fixtures";
export { runFullSourceChecks } from "./full-source-check";
export type { FullSourceCheckReport } from "./full-source-check";
export type { ImportReport } from "./ingest-fixtures";
export { STALE_RUN_AFTER_MS } from "./ingest-fixtures";
export * from "./run-ledger";
export { applyExternal, recordNothing } from "./apply-external";
export { listImportRuns, listImportSources } from "../repo/admin-import-repo";
export type { ExternalApplyRecorder } from "./apply-external";
