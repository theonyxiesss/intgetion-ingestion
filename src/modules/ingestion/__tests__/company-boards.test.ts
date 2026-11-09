import { describe, expect, it } from "vitest";
import {
  boardUrl,
  COMPANY_BOARD_SOURCES,
  COMPANY_BOARDS,
  countriesInText,
  countryFromName,
  countryOfOffice,
  mapAshbyJob,
  mapGreenhouseJob,
  mapLeverJob,
  type CompanyBoard,
} from "../adapters/company-boards";
import { hours } from "../adapters/live";
import { LIVE_SOURCES } from "../service/ingest-fixtures";
import { normalizeImportedJob } from "../service/normalize";

const greenhouse: CompanyBoard = {
  platform: "greenhouse",
  slug: "stripe",
  name: "Stripe",
};
const lever: CompanyBoard = {
  platform: "lever",
  slug: "palantir",
  name: "Palantir",
};
const ashby: CompanyBoard = {
  platform: "ashby",
  slug: "openai",
  name: "OpenAI",
};

describe("company board list (D416)", () => {
  it("runs every board once a day as a whole list, under its company name", () => {
    expect(COMPANY_BOARD_SOURCES).toHaveLength(COMPANY_BOARDS.length);
    for (const source of COMPANY_BOARD_SOURCES) {
      expect(source.feed).toBe("full");
      expect(source.minIntervalMs).toBe(hours(24));
      expect(source.url.startsWith("https://")).toBe(true);
    }
    const names = LIVE_SOURCES.map((source) => source.sourceName);
    expect(new Set(names).size).toBe(names.length);
    const slugs = COMPANY_BOARDS.map(
      (board) => `${board.platform}/${board.slug}`,
    );
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("asks each platform's public board API", () => {
    expect(boardUrl(greenhouse)).toBe(
      "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true",
    );
    expect(boardUrl(lever)).toBe(
      "https://api.lever.co/v0/postings/palantir?mode=json",
    );
    expect(boardUrl(ashby)).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true",
    );
  });
});

describe("place from free text (D416)", () => {
  it("reads countries, states and hubs, and never guesses", () => {
    expect(countriesInText("London, United Kingdom")).toEqual(["GB"]);
    expect(countriesInText("Austin, TX")).toEqual(["US"]);
    expect(countriesInText("Remote from the US")).toEqual(["US"]);
    expect(countriesInText("US-Remote-CA, US-San Francisco")).toEqual(["US"]);
    expect(countriesInText("Toronto, Ontario, Canada; Dublin")).toEqual([
      "CA",
      "IE",
    ]);
    expect(countriesInText("Berlin, Germany")).toEqual(["DE"]);
    expect(countriesInText("Paris")).toEqual(["FR"]);
    expect(countriesInText("Newark, New Jersey")).toEqual(["US"]);
    expect(countriesInText("CA")).toEqual([]);
    expect(countriesInText("Tbilisi, Georgia")).toEqual([]);
    expect(countriesInText("Somewhere nice")).toEqual([]);
    expect(countryFromName("United Kingdom")).toBe("GB");
    expect(countryFromName("France")).toBe("FR");
    expect(countryFromName("Germany")).toBe("DE");
  });

  it("reads a Greenhouse office by its place, its code or its name", () => {
    expect(
      countryOfOffice({
        name: "US-SF-HQ",
        location: "San Francisco, California, United States",
      }),
    ).toBe("US");
    expect(countryOfOffice({ name: "GB-London", location: null })).toBe("GB");
    expect(countryOfOffice({ name: "Ireland Locations", location: null })).toBe(
      "IE",
    );
    expect(countryOfOffice({ name: "UK-London", location: null })).toBe("GB");
    expect(countryOfOffice({ name: "Engineering", location: null })).toBe(null);
  });
});

describe("Greenhouse", () => {
  it("maps a posting with escaped HTML and its offices", () => {
    const job = mapGreenhouseJob(
      {
        id: 7012345,
        title: "Backend Engineer, Payments",
        absolute_url: "https://stripe.com/jobs/search?gh_jid=7012345",
        location: { name: "Dublin" },
        content:
          "&lt;p&gt;Build the money &amp;amp; rails.&lt;/p&gt;&lt;script&gt;x()&lt;/script&gt;",
        departments: [{ name: "Engineering" }],
        offices: [{ name: "Ireland Locations", location: null }],
      },
      greenhouse,
    );
    expect(job).toMatchObject({
      externalId: "7012345",
      companyName: "Stripe",
      applyUrl: "https://stripe.com/jobs/search?gh_jid=7012345",
      category: "engineering",
      workFormat: "onsite",
      location: "Dublin",
      countries: ["IE"],
    });
    expect(job?.description).toContain("Build the money & rails.");
    expect(job?.description).not.toContain("<p>");
    expect(job?.description).not.toContain("x()");
  });

  it("marks remote text as remote and refuses a row without a safe link", () => {
    expect(
      mapGreenhouseJob(
        {
          id: 1,
          title: "Support",
          absolute_url: "https://x.invalid/1",
          location: { name: "Remote - US" },
        },
        greenhouse,
      ),
    ).toMatchObject({ workFormat: "remote", countries: ["US"] });
    expect(
      mapGreenhouseJob(
        { id: 2, title: "Support", absolute_url: "javascript:alert(1)" },
        greenhouse,
      ),
    ).toBeNull();
    expect(
      mapGreenhouseJob(
        { id: 3, title: "Support", absolute_url: "http://x.invalid/3" },
        greenhouse,
      ),
    ).toBeNull();
  });
});

describe("Lever", () => {
  it("maps workplace, country, commitment, lists and pay", () => {
    const job = mapLeverJob(
      {
        id: "6ed76ce8",
        text: "Forward Deployed Engineer",
        hostedUrl: "https://jobs.lever.co/palantir/6ed76ce8",
        categories: {
          location: "London, United Kingdom",
          commitment: "Full-time",
          department: "Engineering",
          allLocations: ["London, United Kingdom"],
        },
        workplaceType: "hybrid",
        country: "GB",
        descriptionPlain: "Work with customers.",
        lists: [{ text: "Requirements", content: "<li>SQL</li>" }],
        salaryRange: {
          min: 90000,
          max: 120000,
          currency: "GBP",
          interval: "per-year-salary",
        },
      },
      lever,
    );
    expect(job).toMatchObject({
      externalId: "6ed76ce8",
      workFormat: "hybrid",
      location: "London, United Kingdom",
      countries: ["GB"],
      employmentType: "full_time",
      category: "engineering",
    });
    expect(job?.description).toContain("### Requirements\n\n- SQL");
    expect(job?.description).toContain("Salary: 90000 – 120000 GBP / year");
  });
});

describe("Ashby", () => {
  it("takes workplaceType over isRemote and reads countries from addresses", () => {
    const job = mapAshbyJob(
      {
        id: "8fb1615c",
        title: "Data Engineer",
        jobUrl: "https://jobs.ashbyhq.com/openai/8fb1615c",
        location: "San Francisco",
        isRemote: true,
        workplaceType: "Hybrid",
        employmentType: "FullTime",
        department: "Data",
        isListed: true,
        address: { postalAddress: { addressCountry: "United States" } },
        secondaryLocations: [
          {
            location: "London",
            address: { postalAddress: { addressCountry: "United Kingdom" } },
          },
        ],
        descriptionPlain: "Pipelines.",
        compensation: { compensationTierSummary: "$200K – $300K" },
      },
      ashby,
    );
    expect(job).toMatchObject({
      workFormat: "hybrid",
      countries: ["US", "GB"],
      employmentType: "full_time",
      category: "data",
    });
    expect(job?.description).toContain("Compensation: $200K – $300K");
  });

  it("skips a posting meant for a direct link only", () => {
    expect(
      mapAshbyJob(
        {
          id: "x",
          title: "Hidden",
          jobUrl: "https://jobs.ashbyhq.com/openai/x",
          isListed: false,
        },
        ashby,
      ),
    ).toBeNull();
  });
});

describe("normalize keeps the stated place (D416)", () => {
  const raw = {
    externalId: "1",
    companyName: "Stripe",
    companyDomain: null,
    title: "Engineer",
    description: "Build things for a while.",
    category: "engineering",
    employmentType: null,
    timeZone: null,
    skills: [],
    applyUrl: "https://stripe.com/jobs/1",
    expiresAt: null,
  };
  const now = new Date("2026-10-14T00:00:00Z");

  it("passes format, location and valid codes through", async () => {
    const job = await normalizeImportedJob(
      {
        ...raw,
        workFormat: "onsite",
        location: "  Dublin ",
        countries: ["ie", "IE", "X1"],
      },
      async () => null,
      now,
      () => false,
    );
    expect(job).toMatchObject({
      workFormat: "onsite",
      location: "Dublin",
      countries: ["IE"],
    });
  });

  it("keeps the remote-only boards remote with no place", async () => {
    const job = await normalizeImportedJob(
      raw,
      async () => null,
      now,
      () => false,
    );
    expect(job).toMatchObject({
      workFormat: "remote",
      location: null,
      countries: [],
    });
  });
});
