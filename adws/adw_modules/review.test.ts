/**
 * The merge is the one piece of the review pair that is pure, so it is the one
 * piece worth testing directly: everything else in review.ts is two phases and
 * a settle. What these pin down is that the adversary's objections reach the
 * builder, and that they never reach the commit decision.
 */

import { describe, expect, test } from "bun:test";

import { mergeReviews } from "./review.ts";
import type { ReviewOutput } from "./types.ts";

const verdict = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
  status: "success",
  summary: "",
  artifacts: [],
  notes_for_next_agent: "",
  approved: true,
  findings: [],
  blocking: [],
  ...over,
});

describe("mergeReviews", () => {
  test("no adversary leaves the reviewer's envelope untouched", () => {
    const review = verdict({ summary: "all four requirements met" });
    expect(mergeReviews(review, null)).toBe(review);
  });

  test("an adversary rejection blocks the merged envelope even when the reviewer approved", () => {
    const merged = mergeReviews(
      verdict({ approved: true, summary: "every requirement met" }),
      verdict({ approved: false, blocking: ["the bare-array response shape changed"] }),
    );
    expect(merged.approved).toBe(false);
    expect(merged.blocking).toEqual(["[adversary] the bare-array response shape changed"]);
  });

  test("blocking items are a de-duplicated union, and the adversary's are marked", () => {
    const merged = mergeReviews(
      verdict({ approved: false, blocking: ["add a test for the empty page"] }),
      verdict({ approved: false, blocking: ["add a test for the empty page", "404 not 500"] }),
    );
    expect(merged.blocking).toEqual([
      "add a test for the empty page",
      "[adversary] add a test for the empty page",
      "[adversary] 404 not 500",
    ]);
  });

  test("findings carry their author, so the builder knows who objected", () => {
    const merged = mergeReviews(
      verdict({ findings: [{ requirement: "accepts ?page=", met: true, evidence: "dto.ts:12" }] }),
      verdict({ findings: [{ requirement: "shape unchanged", met: false, evidence: "svc.ts:40" }] }),
    );
    expect(merged.findings.map((f) => f.evidence)).toEqual([
      "reviewer: dto.ts:12",
      "adversary: svc.ts:40",
    ]);
  });

  test("a clean sweep stays approved", () => {
    const merged = mergeReviews(verdict({ summary: "met" }), verdict({ summary: "nothing extra" }));
    expect(merged.approved).toBe(true);
    expect(merged.blocking).toHaveLength(0);
    expect(merged.summary).toBe("reviewer approved: met · adversary approved: nothing extra");
  });

  test("the merged envelope never contradicts itself the way verdict_consistent refuses", () => {
    const merged = mergeReviews(
      verdict({ approved: true }),
      verdict({ approved: true, blocking: ["an approval that still blocks"] }),
    );
    expect(merged.approved && merged.blocking.length > 0).toBe(false);
  });

  test("both artifact paths survive, so neither report is lost", () => {
    const merged = mergeReviews(
      verdict({ artifacts: ["/h/review.md"] }),
      verdict({ artifacts: ["/h/adversary.md"] }),
    );
    expect(merged.artifacts).toEqual(["/h/review.md", "/h/adversary.md"]);
  });
});
