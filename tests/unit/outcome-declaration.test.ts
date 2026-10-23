import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  companyDomainOf,
  scrapeDeclaration,
  declareRunOutcomesInBackground,
  declareScrapeOutcome,
  postRunOutcomes,
  OutcomeDeclarationError,
} from "../../src/lib/outcome-declaration.js";

describe("companyDomainOf — lead-service's company key (normalizeDomain)", () => {
  it.each([
    ["https://www.Acme.com/about?x=1", "acme.com"],
    ["http://promedica.org/", "promedica.org"],
    ["acme.co.uk:8080/path", "acme.co.uk"],
    ["https://sub.acme.io#top", "sub.acme.io"],
  ])("%s → %s", (raw, domain) => expect(companyDomainOf(raw)).toBe(domain));

  it.each([[""], ["   "], [null], ["http://localhost:3000"], ["https://10.0.0.1/"]])("%s → null (no invented id)", (raw) =>
    expect(companyDomainOf(raw as any)).toBeNull()
  );
});

describe("scrapeDeclaration", () => {
  it("pins company_researched on lead-service + domain, produced only", () => {
    expect(scrapeDeclaration("company_researched", "https://www.acme.com/team")).toEqual({
      produced: [{ outcomeKey: "company_researched", subjectService: "lead-service", subjectId: "acme.com" }],
      consumed: [],
    });
  });
  it("no domain → null", () => expect(scrapeDeclaration("company_researched", "http://localhost")).toBeNull());
});

describe("declareRunOutcomesInBackground — never throws, retries transient failures", () => {
  const body = scrapeDeclaration("company_researched", "https://acme.com")!;
  const id = { orgId: "o", userId: "u" };
  let errSpy: any;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("retries a 5xx then succeeds", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new OutcomeDeclarationError("502 - x", 502))
      .mockRejectedValueOnce(new OutcomeDeclarationError("network: reset", null))
      .mockResolvedValueOnce({ recordedCount: 1, alreadyRecordedCount: 0 });
    expect(await declareRunOutcomesInBackground("run-1", body, id, [0, 0, 0], post)).toBe(true);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("a 4xx is not retried and is logged loud", async () => {
    const post = vi.fn().mockRejectedValue(new OutcomeDeclarationError("400 - unknown_outcome_key", 400));
    expect(await declareRunOutcomesInBackground("run-1", body, id, [0, 0], post)).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("OUTCOME DECLARATION LOST");
  });

  it("gives up after the last delay, loud", async () => {
    const post = vi.fn().mockRejectedValue(new OutcomeDeclarationError("503 - x", 503));
    expect(await declareRunOutcomesInBackground("run-1", body, id, [0, 0], post)).toBe(false);
    expect(post).toHaveBeenCalledTimes(3);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});

describe("postRunOutcomes — contract with runs-service", () => {
  beforeEach(() => {
    process.env.RUNS_SERVICE_API_KEY = "k";
  });
  afterEach(() => vi.restoreAllMocks());

  it("POSTs /v1/runs/{runId}/outcomes with the run's org; a replay reads already_recorded", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ recordedCount: 0, alreadyRecordedCount: 1 }), { status: 200 })
    );
    const body = scrapeDeclaration("company_researched", "https://acme.com")!;
    const out = await postRunOutcomes("run-1", body, { orgId: "org-1", userId: "u-1" });
    expect(out.alreadyRecordedCount).toBe(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/runs\/run-1\/outcomes$/);
    expect((init.headers as any)["x-org-id"]).toBe("org-1");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("a non-2xx throws with its status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 409 }));
    await expect(postRunOutcomes("r", { produced: [], consumed: [] }, { orgId: "o", userId: "u" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("declareScrapeOutcome — route entry", () => {
  afterEach(() => vi.restoreAllMocks());
  it("no outcomeKey → silent no-op", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    declareScrapeOutcome(undefined, "https://acme.com", "run", { orgId: "o", userId: "u" });
    expect(err).not.toHaveBeenCalled();
  });
  it("no run / no domain → logged loud, nothing sent", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    declareScrapeOutcome("company_researched", "https://acme.com", undefined, { orgId: "o", userId: "u" });
    declareScrapeOutcome("company_researched", "http://localhost", "run", { orgId: "o", userId: "u" });
    expect(err).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
