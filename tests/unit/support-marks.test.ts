import { describe, it, expect, vi } from "vitest";
import { markSupport, supportMarkRequest, SupportMarkError } from "../../src/lib/support-marks.js";

const RUN = "869EF40B-E991-49B8-B992-C6F18FEC2C67";

describe("supportMarkRequest", () => {
  it("normalizes and dedups run ids", () => {
    expect(supportMarkRequest("retired_product", " outlets pricing ", "tbilisi", [RUN, RUN.toLowerCase()])).toEqual({
      kind: "retired_product",
      reason: "outlets pricing",
      markedBy: "tbilisi",
      runIds: [RUN.toLowerCase()],
    });
  });

  it("refuses a malformed function name; runs-service validates the list itself", () => {
    expect(() => supportMarkRequest("", "r", "b", [RUN])).toThrow(SupportMarkError);
    expect(() => supportMarkRequest("Staff Experiment", "r", "b", [RUN])).toThrow(SupportMarkError);
    expect(supportMarkRequest("unattributed_production", "r", "b", [RUN]).kind).toBe("unattributed_production");
  });

  it("surfaces runs-service's refusal of an unknown function", async () => {
    const post = vi.fn().mockResolvedValue({ status: 400, body: { error: "Invalid body" } });
    await expect(markSupport("preview", supportMarkRequest("loss", "r", "b", [RUN]), post)).rejects.toThrow(/400/);
  });

  it("refuses a missing reason, no runs, or a non-uuid", () => {
    expect(() => supportMarkRequest("staff_experiment", " ", "b", [RUN])).toThrow(/reason/);
    expect(() => supportMarkRequest("staff_experiment", "r", "b", [])).toThrow(/no run ids/);
    expect(() => supportMarkRequest("staff_experiment", "r", "b", ["abc"])).toThrow(/not run ids/);
  });
});

describe("markSupport", () => {
  const body = supportMarkRequest("staff_experiment", "staff probe", "tbilisi", [RUN]);

  it("returns runs-service's answer on 200", async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, body: { markedCount: 1, alreadyMarkedCount: 0 } });
    await expect(markSupport("apply", body, post)).resolves.toEqual({ markedCount: 1, alreadyMarkedCount: 0 });
    expect(post).toHaveBeenCalledWith("apply", body);
  });

  it("throws on a refusal (e.g. a run that declares an outcome): nothing marked by halves", async () => {
    const post = vi.fn().mockResolvedValue({
      status: 422,
      body: { error: "invalid_runs", details: { invalid: [{ runId: RUN, reason: "run_declares_outcomes" }] } },
    });
    await expect(markSupport("apply", body, post)).rejects.toThrow(/422/);
  });
});
