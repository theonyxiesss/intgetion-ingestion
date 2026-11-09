import { publicHttpUrl } from "@intgetion/companies";
import { notFound } from "@intgetion/kit";
import { getJobForPublic } from "../../../platform";

/** Records `user_job_feedback(action='applied_external')` (D8). */
export type ExternalApplyRecorder = (event: {
  userId: string;
  jobId: string;
}) => Promise<void>;

/**
 * Until 4B adds user_job_feedback this records nothing; the integration of
 * 4B passes its feedback writer here (D72, BLOCKED part of 8A).
 */
export const recordNothing: ExternalApplyRecorder = async () => undefined;

/**
 * D8: applying to an imported job means following its external link; no
 * application row is created. Only jobs the public can see qualify, and
 * only those whose application method is an external URL.
 */
export async function applyExternal(
  jobId: string,
  userId: string | null,
  record: ExternalApplyRecorder = recordNothing,
): Promise<{ externalUrl: string }> {
  // Without a viewer this returns published jobs of visible companies only.
  const job = await getJobForPublic(jobId);
  const externalUrl = publicHttpUrl(job?.applicationUrl);
  if (!job || job.applicationMethod !== "external_url" || !externalUrl) {
    throw notFound();
  }
  if (userId) await record({ userId, jobId: job.id });
  return { externalUrl };
}
