/**
 * What ingestion needs from other modules. Types are the owners' own
 * signatures. In-process the platform wires the real functions; over HTTP
 * see `server/remote-ports.ts`.
 */
import type * as Jobs from "@intgetion/jobs";
import type * as Taxonomy from "@intgetion/taxonomy";

export type IngestionPorts = {
  jobs: {
    saveImportedJob: typeof Jobs.saveImportedJob;
    expireImportedJobs: typeof Jobs.expireImportedJobs;
    getJobForPublic: typeof Jobs.getJobForPublic;
  };
  taxonomy: { normalizeSkill: typeof Taxonomy.normalizeSkill };
  /**
   * companies: the imported company with this domain, else one with a very
   * similar name, else a new unverified one (origin `imported`). Internal
   * companies are never matched, so an import cannot take one over.
   */
  findOrCreateImportedCompany: (name: string, domain: string | null) => Promise<{ id: string }>;
  /** feedback: records `applied_external` once per person and job (D72, D110). */
  recordAppliedExternal: (event: { userId: string; jobId: string }) => Promise<void>;
  /** moderation: one pending queue item per rejected job (13.4). */
  queueRejectedImport: (jobId: string, reason: string) => Promise<void>;
};

let ports: IngestionPorts | null = null;

export function setIngestionPorts(next: IngestionPorts): void {
  ports = next;
}

export function ingestionPorts(): IngestionPorts {
  if (!ports) throw new Error("ingestion ports are not configured");
  return ports;
}
