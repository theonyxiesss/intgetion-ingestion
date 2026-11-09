import type { ImportedJobStatus } from "../../../platform";
import type { RunCounters } from "../repo/import-repo";

/** What one incoming record does to the catalog (13.3, 13.4). */
export type Outcome = {
  status: ImportedJobStatus;
  reason:
    | "scam_pattern_rejected"
    | "duplicate_of_internal"
    | "source_expired"
    | "seen_again"
    | "merged_duplicate"
    | "imported_from_fixture";
  counter: keyof Omit<RunCounters, "fetched">;
  queueForReview: boolean;
};

export function decideOutcome(input: {
  scam: boolean;
  expired: boolean;
  alreadyLinked: boolean;
  duplicate: "internal" | "imported" | null;
}): Outcome {
  if (input.scam) {
    return {
      status: "removed",
      reason: "scam_pattern_rejected",
      counter: "rejected",
      queueForReview: true,
    };
  }
  if (input.duplicate === "internal") {
    return {
      status: "removed",
      reason: "duplicate_of_internal",
      counter: "rejected",
      queueForReview: false,
    };
  }
  if (input.expired) {
    return {
      status: "expired",
      reason: "source_expired",
      counter: "expired",
      queueForReview: false,
    };
  }
  if (input.alreadyLinked) {
    return {
      status: "published",
      reason: "seen_again",
      counter: "updated",
      queueForReview: false,
    };
  }
  if (input.duplicate === "imported") {
    return {
      status: "published",
      reason: "merged_duplicate",
      counter: "merged",
      queueForReview: false,
    };
  }
  return {
    status: "published",
    reason: "imported_from_fixture",
    counter: "created",
    queueForReview: false,
  };
}

/**
 * D412, live feeds: they carry only the newest jobs, so leaving the feed
 * does not close a job. It is stale when no source has seen it since the
 * cutoff.
 */
export function isStaleEverywhere(
  rows: { lastSeenAt: Date }[],
  cutoff: Date,
): boolean {
  return (
    rows.length > 0 &&
    rows.every((row) => row.lastSeenAt.getTime() < cutoff.getTime())
  );
}

/**
 * D416, a whole company board: the job is gone when this board did not
 * list it in the run that started at `runAt`, and no other source has seen
 * it within the window.
 */
export function isGoneFromFullFeed(
  rows: { lastSeenAt: Date; currentSource: boolean }[],
  runAt: Date,
  cutoff: Date,
): boolean {
  const current = rows.filter((row) => row.currentSource);
  const others = rows.filter((row) => !row.currentSource);
  return (
    current.length > 0 &&
    current.every((row) => row.lastSeenAt.getTime() < runAt.getTime()) &&
    others.every((row) => row.lastSeenAt.getTime() < cutoff.getTime())
  );
}

/**
 * 13.4 «no record in the source two runs in a row». Fixture feeds only:
 * they are the whole list (D412). For the current source
 * the run in progress is the second one, so one finished run after the
 * row was last seen is enough; another source of a merged job must have
 * missed two finished runs of its own.
 */
export function isMissingEverywhere(
  rows: { currentSource: boolean; finishedRunsSinceSeen: number }[],
): boolean {
  return (
    rows.length > 0 &&
    rows.every((row) =>
      row.currentSource
        ? row.finishedRunsSinceSeen >= 1
        : row.finishedRunsSinceSeen >= 2,
    )
  );
}
