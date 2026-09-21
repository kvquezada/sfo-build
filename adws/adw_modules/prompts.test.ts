import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { brief, briefRoots, testCommand, type BriefRoots } from "./prompts.ts";
import { TargetConfig } from "./types.ts";

let root: string;
let roots: BriefRoots;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sfo-prompts-"));
  roots = briefRoots(path.join(root, "prompt_engineering"), path.join(root, "data"));
  mkdirSync(roots.team, { recursive: true });
  mkdirSync(roots.personal, { recursive: true });
  writeFileSync(path.join(roots.team, "api.md"), "\nThe team's API brief.\n\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brief", () => {
  test("inlines the team brief, trimmed", () => {
    expect(brief(roots, { brief: "api" })).toBe("The team's API brief.");
  });

  test("a personal brief wins over the team's, whole-file", () => {
    writeFileSync(path.join(roots.personal, "api.md"), "My API brief.");
    expect(brief(roots, { brief: "api" })).toBe("My API brief.");
  });

  test("a personal brief needs no team one", () => {
    writeFileSync(path.join(roots.personal, "oms.md"), "My side project.");
    expect(brief(roots, { brief: "oms" })).toBe("My side project.");
  });

  test("a target with no brief file gets none — never another repo's", () => {
    // The old single _repo_brief.md told every target it was the OMS monorepo.
    writeFileSync(path.join(root, "prompt_engineering", "_repo_brief.md"), "An Nx monorepo.");
    expect(brief(roots, { brief: "ios" })).toBe("");
  });
});

describe("TargetConfig.brief", () => {
  test("defaults to empty, which resolveTarget turns into the target's name", () => {
    expect(TargetConfig.parse({ name: "ios", path: "~/x" }).brief).toBe("");
  });

  test("is a file name, not a path", () => {
    expect(() => TargetConfig.parse({ name: "ios", path: "~/x", brief: "../../secrets" })).toThrow();
  });
});

describe("testCommand", () => {
  test("quotes the target's own argv", () => {
    expect(testCommand({ test: ["swift", "test", "--filter", "Checkout Tests"] })).toBe(
      "swift test --filter 'Checkout Tests'",
    );
  });

  test("a target with no test command gets a refusal, not a guess", () => {
    const line = testCommand({ test: [] });
    expect(line.startsWith("#")).toBe(true);
    expect(line).toContain("do not invent one");
  });
});
