/** Dedup rules of 13.3, as pure functions over rows the repo returns. */

export const TITLE_SIMILARITY = 0.85;
export const DESCRIPTION_SIMILARITY = 0.8;

/** lower + no accents + only letters and digits, as unaccent() would do. */
export function normalizeDedupePart(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type KeyParts = {
  title: string;
  companyDomain: string | null;
  companyName: string;
  location: string | null;
};

/** `lower(unaccent(title)) | company_domain||company_name | location|'remote'` */
export function dedupeKey(job: KeyParts): string {
  return [
    normalizeDedupePart(job.title),
    normalizeDedupePart(job.companyDomain || job.companyName),
    normalizeDedupePart(job.location) || "remote",
  ].join("|");
}

export type DuplicateCandidate = KeyParts & {
  jobId: string;
  source: "internal" | "imported";
  titleSimilarity: number;
  descriptionSimilarity: number;
};

export function isDuplicate(
  incoming: KeyParts,
  candidate: DuplicateCandidate,
): boolean {
  return (
    dedupeKey(incoming) === dedupeKey(candidate) ||
    (candidate.titleSimilarity >= TITLE_SIMILARITY &&
      candidate.descriptionSimilarity >= DESCRIPTION_SIMILARITY)
  );
}

/**
 * The first matching candidate, preferring an internal job: an imported
 * duplicate of an internal job is hidden (13.3), never merged into it.
 */
export function pickDuplicate(
  incoming: KeyParts,
  candidates: readonly DuplicateCandidate[],
): DuplicateCandidate | null {
  const matches = candidates.filter((candidate) =>
    isDuplicate(incoming, candidate),
  );
  return (
    matches.find((candidate) => candidate.source === "internal") ??
    matches[0] ??
    null
  );
}
