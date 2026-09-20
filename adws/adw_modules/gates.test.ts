/**
 * Gates verify claims. These verify the gates.
 *
 * The COPILOT_HOME case is the reason this file exists: a documenter whose
 * writes into the repo and the session directory both failed wrote its report
 * inside its own CLI state directory, declared that absolute path, and passed
 * both artifacts_exist and files_non_empty. Every check was honest and the
 * result was useless — existence was never the property that mattered.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as gates from "./gates.ts";
import { GateReport, SfoConfig, type EnvelopeBase, type Gate, type RunLike } from "./types.ts";

let root: string;
let repoRoot: string;
let sessionDir: string;
let elsewhere: string;
let run: RunLike;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sfo-gates-"));
  repoRoot = path.join(root, "repo");
  sessionDir = path.join(root, "session");
  elsewhere = path.join(root, "copilot_home");
  for (const dir of [repoRoot, sessionDir, elsewhere]) mkdirSync(dir, { recursive: true });
  run = {
    cfg: SfoConfig.parse({}),
    adw_id: "test",
    target: {
      name: "t", path: repoRoot, scope: repoRoot, subdir: "",
      test: [], lint: [], typecheck: [], build: [],
      base_branch: "master", remote: "origin",
    },
    repoRoot,
    sessionDir,
    contextHandoffDir: path.join(sessionDir, "context_handoff"),
    console: { note: () => {} },
    tracer: { event: () => "" },
    phases: [],
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const envelope = (over: Partial<EnvelopeBase> & Record<string, unknown> = {}): EnvelopeBase =>
  ({ status: "success", summary: "", artifacts: [], notes_for_next_agent: "", ...over }) as EnvelopeBase;

const run_ = async (gate: Gate, env: EnvelopeBase) =>
  (await gate(env, run)) as GateReport;

describe("artifacts_exist", () => {
  test("accepts a real file in the repo", async () => {
    writeFileSync(path.join(repoRoot, "spec.md"), "hello");
    const report = await run_(gates.artifacts_exist, envelope({ artifacts: ["spec.md"] }));
    expect(report.passed).toBe(true);
  });

  test("accepts a real file in the session directory", async () => {
    const p = path.join(sessionDir, "scout.md");
    writeFileSync(p, "hello");
    expect((await run_(gates.artifacts_exist, envelope({ artifacts: [p] }))).passed).toBe(true);
  });

  test("rejects a declared file that does not exist", async () => {
    const report = await run_(gates.artifacts_exist, envelope({ artifacts: ["missing.md"] }));
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("does not exist");
  });

  test("rejects a real file written OUTSIDE the repo and the session dir", async () => {
    // The COPILOT_HOME fallback. The file is real and non-empty; nothing reads it.
    const stray = path.join(elsewhere, "report.md");
    writeFileSync(stray, "a perfectly good document nobody will ever see");
    const report = await run_(gates.artifacts_exist, envelope({ artifacts: [stray] }));
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("outside both the repo");
  });

  test("rejects an empty artifact list — a required phase must produce something", async () => {
    expect((await run_(gates.artifacts_exist, envelope({ artifacts: [] }))).passed).toBe(false);
  });
});

describe("files_non_empty", () => {
  test("rejects a zero-byte artifact", async () => {
    writeFileSync(path.join(repoRoot, "empty.md"), "");
    const report = await run_(gates.files_non_empty, envelope({ artifacts: ["empty.md"] }));
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("empty");
  });
});

describe("file_in_repo", () => {
  const gate = gates.file_in_repo("document_path");

  test("accepts a repo-relative path that exists", async () => {
    mkdirSync(path.join(repoRoot, "app_docs"));
    writeFileSync(path.join(repoRoot, "app_docs", "x.md"), "doc");
    expect((await run_(gate, envelope({ document_path: "app_docs/x.md" }))).passed).toBe(true);
  });

  test("rejects a path outside the repo even when the file is real", async () => {
    const stray = path.join(elsewhere, "x.md");
    writeFileSync(stray, "doc");
    const report = await run_(gate, envelope({ document_path: stray }));
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("must be inside the repo");
  });

  test("rejects an empty field", async () => {
    expect((await run_(gate, envelope({ document_path: "" }))).passed).toBe(false);
  });

  test("rejects the session directory too — a shipped doc is not a handoff", async () => {
    const p = path.join(sessionDir, "x.md");
    writeFileSync(p, "doc");
    expect((await run_(gate, envelope({ document_path: p }))).passed).toBe(false);
  });
});

describe("diff_matches_claims", () => {
  test("rejects a build that claims nothing changed", async () => {
    const report = await run_(gates.diff_matches_claims, envelope({ changed_files: [] }));
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("changed nothing");
  });

  test("rejects a claimed file that is not on disk", async () => {
    const report = await run_(gates.diff_matches_claims, envelope({ changed_files: ["ghost.ts"] }));
    expect(report.passed).toBe(false);
  });
});

describe("verdict_consistent", () => {
  test("refuses an approval that ships blocking items", async () => {
    const report = await run_(
      gates.verdict_consistent,
      envelope({ approved: true, blocking: ["missing tests"], findings: [] }),
    );
    expect(report.passed).toBe(false);
  });

  test("refuses an approval with an unmet requirement", async () => {
    const report = await run_(
      gates.verdict_consistent,
      envelope({ approved: true, blocking: [], findings: [{ requirement: "pagination", met: false }] }),
    );
    expect(report.passed).toBe(false);
  });

  test("refuses a rejection that names no problem", async () => {
    const report = await run_(
      gates.verdict_consistent,
      envelope({ approved: false, blocking: [], findings: [] }),
    );
    expect(report.passed).toBe(false);
  });

  test("accepts a supported approval and a supported rejection", async () => {
    expect(
      (await run_(gates.verdict_consistent, envelope({ approved: true, blocking: [], findings: [{ requirement: "x", met: true }] }))).passed,
    ).toBe(true);
    expect(
      (await run_(gates.verdict_consistent, envelope({ approved: false, blocking: ["no tests"], findings: [] }))).passed,
    ).toBe(true);
  });
});
