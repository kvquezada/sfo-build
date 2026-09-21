import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { brief, testCommand } from "./prompts.ts";
import { TargetConfig } from "./types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sfo-prompts-"));
  mkdirSync(path.join(root, "_briefs"));
  writeFileSync(path.join(root, "_briefs", "oms.md"), "\nAn Nx monorepo.\n\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brief", () => {
  test("inlines the target's own brief, trimmed", () => {
    expect(brief(root, { brief: "oms" })).toBe("An Nx monorepo.");
  });

  test("a target with no brief file gets none — never another repo's", () => {
    // The old single _repo_brief.md told every target it was the OMS monorepo.
    writeFileSync(path.join(root, "_repo_brief.md"), "An Nx monorepo.");
    expect(brief(root, { brief: "ios" })).toBe("");
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
