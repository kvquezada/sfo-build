/**
 * The pure half of git_helper: naming a branch after the commits it carries.
 *
 * No git here. Everything under test is a string transformation, which is
 * exactly why the branch name is derived rather than asked of a model — the
 * rule is small enough to state, so it is small enough to test.
 */

import { describe, expect, test } from "bun:test";

import { branchFor, slugify, subjectLine } from "./git_helper.ts";

describe("slugify", () => {
  test("lowercases and dashes", () => {
    expect(slugify("Add Pagination")).toBe("add-pagination");
  });

  test("collapses runs of punctuation into one dash", () => {
    expect(slugify("add   pagination -- to /customers")).toBe("add-pagination-to-customers");
  });

  test("strips leading and trailing dashes", () => {
    expect(slugify("  :: add pagination ::  ")).toBe("add-pagination");
  });

  test("folds accents rather than dropping the word", () => {
    expect(slugify("café ordering")).toBe("cafe-ordering");
  });

  test("drops characters with no ascii form", () => {
    expect(slugify("日本語 orders")).toBe("orders");
  });

  test("caps length on a word boundary", () => {
    const slug = slugify(
      "add cursor based pagination to the customers endpoint and document it",
    );
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("add-cursor-based-pagination-to-the-customers");
  });

  test("cuts mid-word when there is no boundary to cut on", () => {
    const slug = slugify("a".repeat(80));
    expect(slug).toBe("a".repeat(48));
  });

  test("empty in, empty out", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
  });
});

describe("branchFor", () => {
  const ID = "ab12cd34";

  test("feat names the branch, and keeps its subject as the title", () => {
    const got = branchFor(["feat(api): add pagination to GET /customers"], ID);
    expect(got.prefix).toBe("feature");
    expect(got.name).toBe("feature/add-pagination-to-get-customers");
    expect(got.title).toBe("feat(api): add pagination to GET /customers");
  });

  test("a docs commit never names the branch, even when it lands first", () => {
    const got = branchFor(
      ["docs(api): document customer pagination", "feat(api): add pagination"],
      ID,
    );
    expect(got.name).toBe("feature/add-pagination");
    expect(got.title).toBe("feat(api): add pagination");
  });

  test("feat wins over fix", () => {
    const got = branchFor(["fix(api): correct the offset", "feat(api): add pagination"], ID);
    expect(got.prefix).toBe("feature");
    expect(got.title).toBe("feat(api): add pagination");
  });

  test("fix wins when there is no feat", () => {
    const got = branchFor(
      ["docs: note the fix", "fix(api): correct the offset by one"],
      ID,
    );
    expect(got.prefix).toBe("fix");
    expect(got.name).toBe("fix/correct-the-offset-by-one");
  });

  test("everything else is a chore, named after the first commit", () => {
    const got = branchFor(["refactor(api): split the service", "docs: note it"], ID);
    expect(got.prefix).toBe("chore");
    expect(got.name).toBe("chore/split-the-service");
  });

  test("docs-only is a chore", () => {
    const got = branchFor(["docs: document the pagination"], ID);
    expect(got.prefix).toBe("chore");
    expect(got.name).toBe("chore/document-the-pagination");
  });

  test("a breaking marker does not change the type", () => {
    const got = branchFor(["feat(api)!: drop the v1 list endpoint"], ID);
    expect(got.prefix).toBe("feature");
    expect(got.name).toBe("feature/drop-the-v1-list-endpoint");
  });

  test("non-conventional subjects fall back to the first one, as written", () => {
    const got = branchFor(["Rework the masthead", "and fix the gauge"], ID);
    expect(got.prefix).toBe("chore");
    expect(got.name).toBe("chore/rework-the-masthead");
    expect(got.title).toBe("Rework the masthead");
  });

  test("a mix picks the conventional one over the prose one", () => {
    const got = branchFor(["Rework the masthead", "feat(ui): add a breadcrumb"], ID);
    expect(got.name).toBe("feature/add-a-breadcrumb");
  });

  test("no commits at all still yields a usable name", () => {
    const got = branchFor([], ID);
    expect(got.name).toBe(`chore/${ID}`);
    expect(got.title).toBe(`chore: ${ID}`);
  });

  test("a subject that slugifies to nothing falls back to the adw_id", () => {
    const got = branchFor(["feat: 日本語"], ID);
    expect(got.name).toBe(`feature/${ID}`);
  });
});

describe("subjectLine", () => {
  test("keeps a conventional subject verbatim", () => {
    expect(subjectLine("feat(api): add pagination")).toBe("feat(api): add pagination");
  });

  test("gives an untyped subject a chore type", () => {
    expect(subjectLine("Rework the masthead")).toBe("chore: Rework the masthead");
  });

  test("drops everything after the first line", () => {
    expect(subjectLine("fix: correct the offset\n\nA body nobody asked for.")).toBe(
      "fix: correct the offset",
    );
  });

  test("skips leading blank lines", () => {
    expect(subjectLine("\n\n  feat: add a gauge  ")).toBe("feat: add a gauge");
  });
});
