/**
 * Fixture feeds are made-up jobs for tests (8A). The cloud database serves
 * localhost and production alike, so a fixture run there publishes fiction
 * on the live site. They run only against a database on this machine (D412).
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const FIXTURES_NEED_LOCAL_DATABASE =
  "fixtures_skipped: the database is not local";

export function fixtureImportAllowed(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;
  try {
    return LOCAL_HOSTS.has(new URL(databaseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}
