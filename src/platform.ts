/** The names ingestion used from other modules, answered by ports. */
import { ingestionPorts, type IngestionPorts } from "./ports";

type Args<F> = F extends (...args: infer A) => unknown ? A : never;

export type { ImportedJobStatus } from "@intgetion/jobs";

export const saveImportedJob = (...a: Args<IngestionPorts["jobs"]["saveImportedJob"]>) =>
  ingestionPorts().jobs.saveImportedJob(...a);
export const expireImportedJobs = (...a: Args<IngestionPorts["jobs"]["expireImportedJobs"]>) =>
  ingestionPorts().jobs.expireImportedJobs(...a);
export const getJobForPublic = (...a: Args<IngestionPorts["jobs"]["getJobForPublic"]>) =>
  ingestionPorts().jobs.getJobForPublic(...a);
export const normalizeSkill = (...a: Args<IngestionPorts["taxonomy"]["normalizeSkill"]>) =>
  ingestionPorts().taxonomy.normalizeSkill(...a);
