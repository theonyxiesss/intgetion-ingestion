import { describe, expect, it } from "vitest";
import { mapHimalayasJob } from "../adapters/himalayas";
import { mapJobicyJob } from "../adapters/jobicy";
import { plain, withinCreateBudget } from "../adapters/live";
import { mapRemoteOkJob, remoteOkSource } from "../adapters/remoteok";
import { mapRemotiveJob } from "../adapters/remotive";

describe("live adapters (8B, D375)", () => {
  it("Remotive: keeps the Remotive page as the apply link", () => {
    const job = mapRemotiveJob({
      id: 12,
      url: "https://remotive.com/remote-jobs/software-development/role-12",
      title: "Backend Engineer",
      company_name: "North",
      category: "Software Development",
      job_type: "full_time",
      tags: ["TypeScript", 1],
      description: "<p>Build APIs.</p><script>alert(1)</script>",
      salary: "$100k",
      candidate_required_location: "Europe",
    });
    expect(job).toMatchObject({
      externalId: "12",
      category: "engineering",
      employmentType: "full_time",
      skills: ["TypeScript"],
      applyUrl: "https://remotive.com/remote-jobs/software-development/role-12",
    });
    expect(job?.description).toContain("Build APIs.");
    expect(job?.description).toContain("$100k");
    expect(job?.description).toContain("Location: Europe");
    expect(job?.description).not.toContain("alert");
    expect(mapRemotiveJob({ id: 1, title: "X", company_name: "Y" })).toBeNull();
  });

  it("Himalayas: page as id and link, salary and location as text", () => {
    const url = "https://himalayas.app/companies/acme/jobs/designer";
    const job = mapHimalayasJob({
      title: "Product Designer",
      companyName: "Acme",
      employmentType: "Full Time",
      minSalary: 90000,
      maxSalary: 120000,
      currency: "USD",
      salaryPeriod: "annual",
      locationRestrictions: ["Germany", "Austria"],
      categories: ["Product-Design"],
      parentCategories: ["Design"],
      description: "<h3>Hi</h3><p>Design things.</p>",
      expiryDate: 1796567327,
      applicationLink: url,
      guid: url,
    });
    expect(job).toMatchObject({
      externalId: url,
      applyUrl: url,
      category: "design",
      employmentType: "full_time",
      skills: ["Product Design"],
    });
    expect(job?.description).toContain("Salary: 90000 – 120000 USD / annual");
    expect(job?.description).toContain("Location: Germany, Austria");
    expect(job?.expiresAt).toMatch(/^2026-/);
    expect(
      mapHimalayasJob({
        title: "X",
        companyName: "Y",
        applicationLink: "https://evil.example/x",
      }),
    ).toBeNull();
  });

  it("Jobicy: industry to category, the worldwide geo is not a location", () => {
    const job = mapJobicyJob({
      id: 154779,
      url: "https://jobicy.com/jobs/154779-data-scientist",
      jobTitle: "Data Scientist",
      companyName: "Pinterest",
      jobIndustry: ["Data Science & Analytics"],
      jobType: ["Full-Time"],
      jobGeo: "Anywhere",
      jobDescription: "<p>Models &amp; data.</p>",
      salaryMin: 114297,
      salaryMax: 235319,
      salaryCurrency: "USD",
      salaryPeriod: "yearly",
    });
    expect(job).toMatchObject({
      externalId: "154779",
      category: "data",
      employmentType: "full_time",
    });
    expect(job?.description).toContain("Models & data.");
    expect(job?.description).toContain("Salary: 114297 – 235319 USD / yearly");
    expect(job?.description).not.toContain("Location");
  });

  it("Remote OK: skips the legal notice row and reads part time from tags", async () => {
    const rows = [
      { last_updated: 1, legal: "API Terms of Service" },
      {
        id: "1137465",
        position: "Platform Engineer",
        company: "RedMimicry",
        tags: ["golang", "part time"],
        description: "Mostly remote.",
        location: "",
        salary_min: 0,
        salary_max: 0,
        url: "https://remoteOK.com/remote-jobs/platform-engineer-1137465",
      },
    ];
    const fakeFetch = (async () =>
      new Response(JSON.stringify(rows))) as unknown as typeof fetch;
    const jobs = await remoteOkSource.fetch(fakeFetch);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      externalId: "1137465",
      employmentType: "part_time",
      skills: ["golang", "part time"],
    });
    expect(jobs[0]?.description).not.toContain("Salary");
    expect(mapRemoteOkJob(rows[0]!)).toBeNull();
  });

  it("plain() turns the source's HTML into Markdown (D591)", () => {
    expect(plain("<p>One</p><p>Two &lt;3</p><br>Three")).toBe(
      "One\n\nTwo \\<3\n\nThree",
    );
    expect(
      plain(
        '<h2>About</h2><p>We <b>build</b> <a href="https://x.dev/a">tools</a>.</p>' +
          "<h3>You will</h3><ul><li>Ship <strong>APIs</strong></li><li>Review</li></ul>" +
          '<p><img src="https://x.dev/t.gif"><iframe src="https://x.dev"></iframe>' +
          '<a href="javascript:alert(1)">Apply</a></p>',
      ),
    ).toBe(
      "### About\n\nWe **build** [tools](https://x.dev/a).\n\n" +
        "### You will\n\n- Ship **APIs**\n- Review\n\nApply",
    );
    expect(plain(`<p>${"word ".repeat(3000)}</p>`).length).toBeLessThanOrEqual(
      8000,
    );
  });

  it("refreshes jobs already stored and adds only a few new ones", () => {
    const rows = ["a", "b", "c", "d"].map((externalId) => ({ externalId }));
    expect(
      withinCreateBudget(rows, new Set(["b"]), 2).map((row) => row.externalId),
    ).toEqual(["a", "b", "c"]);
  });
});
