/**
 * One job as a source delivers it, before normalization. Adapters only
 * reshape fields; every rule lives in normalize/dedup (13.1, D70).
 */
export type RawImportedJob = {
  externalId: string;
  companyName: string;
  companyDomain: string | null;
  title: string;
  description: string;
  category: string;
  employmentType: string | null;
  timeZone: string | null;
  skills: string[];
  applyUrl: string;
  expiresAt: string | null;
  /**
   * Place, only when the source states it (D416). Without it the job is
   * remote with no country, as for the remote-only boards.
   */
  workFormat?: "remote" | "hybrid" | "onsite";
  /** City or region text as the source writes it. */
  location?: string | null;
  /** ISO 3166-1 alpha-2 codes of the countries the job is in or open to. */
  countries?: string[];
};

export interface ImportAdapter {
  readonly sourceName: string;
  readonly kind: "api" | "rss";
  /** 8A reads fixtures only; there is no network fetch (D18). */
  loadFixture(): Promise<RawImportedJob[]>;
}
