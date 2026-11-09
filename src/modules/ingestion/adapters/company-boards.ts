import {
  BOARD_FETCH_TIMEOUT_MS,
  LIVE_STALE_AFTER_MS,
  employment,
  fetchJson,
  hours,
  idOf,
  mapRows,
  plain,
  publicHttps,
  salaryLine,
  strings,
  text,
  withFacts,
  type LiveSource,
} from "./live";
import type { RawImportedJob } from "./types";

/**
 * Company career boards (D416): the public job-board APIs of Greenhouse,
 * Lever and Ashby, where companies publish their own openings for anyone
 * to read. No key and no login. Each company is its own source: the link
 * back is the employer's own posting, and a job gone from the board is
 * closed. The founder approved these on 2026-10-14.
 */
export type BoardPlatform = "greenhouse" | "lever" | "ashby";

export type CompanyBoard = {
  platform: BoardPlatform;
  /** The board name in the platform's URL. */
  slug: string;
  /** Shown as the source: «Original on <name>». */
  name: string;
};

/**
 * Boards checked live on 2026-10-14: each answered with open jobs. Boards
 * that answered empty or not at all were left out.
 */
export const COMPANY_BOARDS: readonly CompanyBoard[] = [
  { platform: "greenhouse", slug: "gitlab", name: "GitLab" },
  { platform: "greenhouse", slug: "stripe", name: "Stripe" },
  { platform: "greenhouse", slug: "cloudflare", name: "Cloudflare" },
  { platform: "greenhouse", slug: "discord", name: "Discord" },
  { platform: "greenhouse", slug: "figma", name: "Figma" },
  { platform: "greenhouse", slug: "coinbase", name: "Coinbase" },
  { platform: "greenhouse", slug: "dropbox", name: "Dropbox" },
  { platform: "greenhouse", slug: "reddit", name: "Reddit" },
  { platform: "greenhouse", slug: "twilio", name: "Twilio" },
  { platform: "greenhouse", slug: "datadog", name: "Datadog" },
  { platform: "greenhouse", slug: "elastic", name: "Elastic" },
  { platform: "greenhouse", slug: "mongodb", name: "MongoDB" },
  { platform: "greenhouse", slug: "duolingo", name: "Duolingo" },
  { platform: "greenhouse", slug: "canonical", name: "Canonical" },
  { platform: "greenhouse", slug: "airbnb", name: "Airbnb" },
  { platform: "greenhouse", slug: "robinhood", name: "Robinhood" },
  { platform: "greenhouse", slug: "okta", name: "Okta" },
  { platform: "greenhouse", slug: "gusto", name: "Gusto" },
  { platform: "greenhouse", slug: "asana", name: "Asana" },
  { platform: "greenhouse", slug: "instacart", name: "Instacart" },
  { platform: "greenhouse", slug: "pinterest", name: "Pinterest" },
  { platform: "greenhouse", slug: "lyft", name: "Lyft" },
  { platform: "lever", slug: "palantir", name: "Palantir" },
  { platform: "lever", slug: "spotify", name: "Spotify" },
  { platform: "lever", slug: "binance", name: "Binance" },
  { platform: "lever", slug: "zoox", name: "Zoox" },
  { platform: "lever", slug: "outreach", name: "Outreach" },
  { platform: "ashby", slug: "ramp", name: "Ramp" },
  { platform: "ashby", slug: "notion", name: "Notion" },
  { platform: "ashby", slug: "linear", name: "Linear" },
  { platform: "ashby", slug: "openai", name: "OpenAI" },
  { platform: "ashby", slug: "supabase", name: "Supabase" },
  { platform: "ashby", slug: "posthog", name: "PostHog" },
  { platform: "ashby", slug: "zapier", name: "Zapier" },
  { platform: "ashby", slug: "cursor", name: "Cursor" },
  { platform: "ashby", slug: "replit", name: "Replit" },
  { platform: "ashby", slug: "sentry", name: "Sentry" },
  { platform: "ashby", slug: "clickup", name: "ClickUp" },
  { platform: "ashby", slug: "1password", name: "1Password" },
];

// ── Place ───────────────────────────────────────────────────────────────

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  ),
);

const COUNTRY_ALIASES: Record<string, string> = {
  us: "US",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "united states of america": "US",
  america: "US",
  uk: "GB",
  "u.k.": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  uae: "AE",
  "south korea": "KR",
  korea: "KR",
  "czech republic": "CZ",
  holland: "NL",
  turkey: "TR",
  russia: "RU",
  vietnam: "VN",
};

/**
 * Region codes Intl knows that are not current ISO 3166 countries: old
 * ones (DD East Germany, SU, YU…), reservations (UK, FX, AC…) and groups.
 */
const NOT_COUNTRIES = new Set(
  "AN BU CS DD DY FX HV NH NT RH SU TP UK VD YD YU ZR AC CP DG EA IC TA EU EZ UN QO XA XB ZZ".split(
    " ",
  ),
);

let countryNames: Map<string, string> | undefined;

/** English country names from the runtime, so no list is kept by hand. */
function countryByName(): Map<string, string> {
  if (countryNames) return countryNames;
  const names = new Map<string, string>();
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) {
    for (const b of letters) {
      const code = `${a}${b}`;
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        name = undefined;
      }
      // First code wins (GB before UK, FR before FX); groups are not countries.
      if (
        name &&
        name !== code &&
        !NOT_COUNTRIES.has(code) &&
        !names.has(name.toLowerCase())
      ) {
        names.set(name.toLowerCase(), code);
      }
    }
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    names.set(alias, code);
  }
  countryNames = names;
  return names;
}

/** Names that are both a country and a US state or place: never guessed. */
const AMBIGUOUS = new Set(["georgia", "jersey", "guernsey"]);

const US_STATE_NAMES = new Set([
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming",
  "district of columbia",
]);

/** Large hubs a board often names alone («Dublin», «SF, NYC»). */
const CITY_COUNTRY: Record<string, string> = {
  "san francisco": "US",
  sf: "US",
  "new york city": "US",
  nyc: "US",
  seattle: "US",
  sea: "US",
  chicago: "US",
  chi: "US",
  austin: "US",
  boston: "US",
  "los angeles": "US",
  denver: "US",
  atlanta: "US",
  "washington d.c.": "US",
  "washington dc": "US",
  "palo alto": "US",
  "mountain view": "US",
  "san jose": "US",
  "san mateo": "US",
  london: "GB",
  dublin: "IE",
  toronto: "CA",
  vancouver: "CA",
  montreal: "CA",
  berlin: "DE",
  munich: "DE",
  paris: "FR",
  amsterdam: "NL",
  sydney: "AU",
  melbourne: "AU",
  singapore: "SG",
  tokyo: "JP",
  bangalore: "IN",
  bengaluru: "IN",
  hyderabad: "IN",
  pune: "IN",
  "tel aviv": "IL",
  madrid: "ES",
  barcelona: "ES",
  stockholm: "SE",
  zurich: "CH",
  "são paulo": "BR",
  "sao paulo": "BR",
  "mexico city": "MX",
  warsaw: "PL",
  lisbon: "PT",
};

/** An English country name or a known alias → ISO code, else null. */
export function countryFromName(value: string): string | null {
  const key = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key || AMBIGUOUS.has(key)) return null;
  return countryByName().get(key) ?? null;
}

function isRegionCode(code: string): boolean {
  return [...countryByName().values()].includes(code);
}

/** One phrase: a country, a US state, or a known hub. */
function placeCountry(phrase: string): string | null {
  const key = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  if (US_STATE_NAMES.has(key)) return "US";
  return countryFromName(key) ?? CITY_COUNTRY[key] ?? null;
}

/**
 * Countries in a free location text: «San Francisco, CA», «London, United
 * Kingdom», «Remote from the US», «US-Remote-CA, Toronto». A bare
 * two-letter code counts only after a city («Austin, TX» is the US; «CA»
 * alone is not read). Unknown text gives no country, never a guess.
 */
export function countriesInText(value: string): string[] {
  const found: string[] = [];
  for (const place of value.split(/[;|/]| or /i)) {
    const parts = place
      .split(/[,()]|\s[-–]\s/)
      .map((part) => part.trim())
      .filter(Boolean);
    let matched = false;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index] ?? "";
      const named = placeCountry(part);
      if (named) {
        found.push(named);
        matched = true;
        break;
      }
      if (/^[A-Z]{2}$/.test(part) && index > 0 && US_STATES.has(part)) {
        found.push("US");
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // Phrases inside the text, longest first: «Remote from the US».
    const words = place.split(/[^\p{L}.']+/u).filter(Boolean);
    search: for (let size = 3; size >= 1; size -= 1) {
      for (let start = 0; start + size <= words.length; start += 1) {
        const phrase = words.slice(start, start + size).join(" ");
        // Two-letter words only as US/UK aliases, never as codes.
        if (size === 1 && phrase.length === 2 && !/^(US|UK)$/.test(phrase)) {
          continue;
        }
        const named = placeCountry(phrase);
        if (named) {
          found.push(named);
          break search;
        }
      }
    }
  }
  return [...new Set(found)];
}

/** «Ireland Locations», «US-SF-HQ», «GB-London» from a Greenhouse office. */
export function countryOfOffice(office: {
  name?: unknown;
  location?: unknown;
}): string | null {
  const location = text(office.location);
  const fromLocation = location ? countriesInText(location)[0] : undefined;
  if (fromLocation) return fromLocation;
  const name = text(office.name);
  const prefix = /^([A-Z]{2})(?:-|$)/.exec(name)?.[1];
  if (prefix && isRegionCode(prefix)) return prefix;
  return countriesInText(name.replace(/\s+locations?$/i, ""))[0] ?? null;
}

function formatFromText(
  value: string,
): "remote" | "hybrid" | "onsite" | undefined {
  if (/\bhybrid\b/i.test(value)) return "hybrid";
  if (/\b(remote|anywhere|distributed)\b/i.test(value)) return "remote";
  return value.trim() ? "onsite" : undefined;
}

/** Greenhouse sends its HTML escaped (&lt;p&gt;). */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

// ── Greenhouse ─────────────────────────────────────────────────────────

export function mapGreenhouseJob(
  row: Record<string, unknown>,
  board: CompanyBoard,
): RawImportedJob | null {
  const id = idOf(row.id);
  const title = text(row.title);
  const url = publicHttps(text(row.absolute_url));
  if (!id || !title || !url) return null;
  const location = text((row.location as { name?: unknown } | null)?.name);
  const department = text(
    (Array.isArray(row.departments)
      ? (row.departments[0] as { name?: unknown } | undefined)
      : undefined
    )?.name,
  );
  return {
    externalId: id,
    companyName: board.name,
    companyDomain: null,
    title,
    description:
      withFacts(plain(unescapeHtml(text(row.content))), [
        location ? `Location: ${location}` : null,
      ]) || title,
    category: department.toLowerCase(),
    employmentType: null,
    timeZone: null,
    skills: [],
    applyUrl: url,
    expiresAt: null,
    workFormat: formatFromText(location),
    location: location || null,
    countries: [
      ...new Set([
        ...countriesInText(location),
        ...(Array.isArray(row.offices) ? row.offices : [])
          .map((office) =>
            office && typeof office === "object"
              ? countryOfOffice(office as Record<string, unknown>)
              : null,
          )
          .filter((code): code is string => code !== null),
      ]),
    ],
  };
}

// ── Lever ──────────────────────────────────────────────────────────────

const LEVER_INTERVAL: Record<string, string> = {
  "per-year-salary": "year",
  "per-month-salary": "month",
  "per-hour-wage": "hour",
};

function leverLists(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const list = item as { text?: unknown; content?: unknown };
    const body = plain(text(list.content));
    const heading = text(list.text);
    return body ? [heading ? `### ${heading}\n\n${body}` : body] : [];
  });
}

export function mapLeverJob(
  row: Record<string, unknown>,
  board: CompanyBoard,
): RawImportedJob | null {
  const id = idOf(row.id);
  const title = text(row.text);
  const url = publicHttps(text(row.hostedUrl));
  if (!id || !title || !url) return null;
  const categories = (row.categories ?? {}) as Record<string, unknown>;
  const location = text(categories.location);
  const workplace = text(row.workplaceType).toLowerCase();
  const country = text(row.country).toUpperCase();
  const salary = (row.salaryRange ?? null) as Record<string, unknown> | null;
  return {
    externalId: id,
    companyName: board.name,
    companyDomain: null,
    title,
    description:
      withFacts(plain(text(row.description)) || text(row.descriptionPlain), [
        ...leverLists(row.lists),
        plain(text(row.additional)) || text(row.additionalPlain),
        salary
          ? salaryLine(
              salary.min,
              salary.max,
              text(salary.currency),
              LEVER_INTERVAL[text(salary.interval)] ?? "",
            )
          : null,
        location ? `Location: ${location}` : null,
      ]).slice(0, 8000) || title,
    category: (text(categories.department) || text(categories.team))
      .toLowerCase()
      .trim(),
    employmentType: employment(text(categories.commitment)),
    timeZone: null,
    skills: [],
    applyUrl: url,
    expiresAt: null,
    workFormat:
      workplace === "remote"
        ? "remote"
        : workplace === "hybrid"
          ? "hybrid"
          : workplace === "on-site"
            ? "onsite"
            : formatFromText(location),
    location: location || null,
    countries: /^[A-Z]{2}$/.test(country)
      ? [country]
      : countriesInText(
          [location, ...strings(categories.allLocations)].join("; "),
        ),
  };
}

// ── Ashby ──────────────────────────────────────────────────────────────

function ashbyCountry(value: unknown): string | null {
  const address = (value ?? {}) as {
    postalAddress?: { addressCountry?: unknown };
  };
  return countryFromName(text(address.postalAddress?.addressCountry));
}

export function mapAshbyJob(
  row: Record<string, unknown>,
  board: CompanyBoard,
): RawImportedJob | null {
  const id = idOf(row.id);
  const title = text(row.title);
  const url = publicHttps(text(row.jobUrl));
  // Unlisted jobs are meant for a direct link only (Ashby docs).
  if (!id || !title || !url || row.isListed === false) return null;
  const location = text(row.location);
  const workplace = text(row.workplaceType).toLowerCase();
  const secondary = Array.isArray(row.secondaryLocations)
    ? (row.secondaryLocations as Record<string, unknown>[])
    : [];
  const countries = [
    ashbyCountry(row.address),
    ...secondary.map((item) => ashbyCountry(item.address)),
  ].filter((code): code is string => code !== null);
  const compensation = text(
    (row.compensation as { compensationTierSummary?: unknown } | null)
      ?.compensationTierSummary,
  );
  return {
    externalId: id,
    companyName: board.name,
    companyDomain: null,
    title,
    description:
      withFacts(
        plain(text(row.descriptionHtml)) || text(row.descriptionPlain),
        [
          compensation ? `Compensation: ${compensation}` : null,
          location ? `Location: ${location}` : null,
        ],
      ).slice(0, 8000) || title,
    category: text(row.department).toLowerCase(),
    employmentType: employment(text(row.employmentType)),
    timeZone: null,
    skills: [],
    applyUrl: url,
    expiresAt: null,
    // workplaceType wins: Ashby also sets isRemote on hybrid jobs.
    workFormat:
      workplace === "remote"
        ? "remote"
        : workplace === "hybrid"
          ? "hybrid"
          : workplace === "onsite"
            ? "onsite"
            : row.isRemote === true
              ? "remote"
              : formatFromText(location),
    location: location || null,
    countries: countries.length ? countries : countriesInText(location),
  };
}

// ── Sources ────────────────────────────────────────────────────────────

export function boardUrl(board: CompanyBoard): string {
  const slug = encodeURIComponent(board.slug);
  switch (board.platform) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  }
}

function rowsOf(board: CompanyBoard, body: unknown): unknown {
  if (board.platform === "lever") return body;
  return (body as { jobs?: unknown } | null)?.jobs;
}

const MAPPERS: Record<
  BoardPlatform,
  (row: Record<string, unknown>, board: CompanyBoard) => RawImportedJob | null
> = {
  greenhouse: mapGreenhouseJob,
  lever: mapLeverJob,
  ashby: mapAshbyJob,
};

export function companyBoardSource(board: CompanyBoard): LiveSource {
  const url = boardUrl(board);
  return {
    sourceName: board.name,
    kind: "api",
    url,
    // A company board changes slowly; once a day keeps ~40 boards in turn.
    minIntervalMs: hours(24),
    newPerRun: 15,
    staleAfterMs: LIVE_STALE_AFTER_MS,
    feed: "full",
    async fetch(fetchImpl) {
      const body = await fetchJson(url, fetchImpl, BOARD_FETCH_TIMEOUT_MS);
      return mapRows(rowsOf(board, body), (row) =>
        MAPPERS[board.platform](row, board),
      );
    },
  };
}

export const COMPANY_BOARD_SOURCES: readonly LiveSource[] =
  COMPANY_BOARDS.map(companyBoardSource);
