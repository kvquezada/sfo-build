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
import {
  GateReport,
  MapOutput,
  OptionsOutput,
  SfoConfig,
  type EnvelopeBase,
  type Gate,
  type RunLike,
} from "./types.ts";

let root: string;
let repoRoot: string;
/** A SECOND checkout, so the cross-repo gates have a real other tree to stat. */
let otherRoot: string;
let sessionDir: string;
let elsewhere: string;
let run: RunLike;

const target = (name: string, repoPath: string) => ({
  name, path: repoPath, scope: repoPath, subdir: "",
  test: [], lint: [], typecheck: [], build: [],
  base_branch: "master", remote: "origin", brief: name,
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sfo-gates-"));
  repoRoot = path.join(root, "repo");
  otherRoot = path.join(root, "other");
  sessionDir = path.join(root, "session");
  elsewhere = path.join(root, "copilot_home");
  for (const dir of [repoRoot, otherRoot, sessionDir, elsewhere]) {
    mkdirSync(dir, { recursive: true });
  }
  run = {
    cfg: SfoConfig.parse({}),
    adw_id: "test",
    target: target("t", repoRoot),
    targets: [target("t", repoRoot), target("other", otherRoot)],
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

/**
 * The cross-repo half. An agent only ever saw one of these trees; the gate
 * stands outside both and checks the trail anyway.
 */
describe("hops_resolve", () => {
  const hop = (target: string, file: string) => ({ target, file, note: "" });

  test("accepts a trail whose hops land in two different repos", async () => {
    writeFileSync(path.join(repoRoot, "caller.ts"), "post()");
    writeFileSync(path.join(otherRoot, "handler.ts"), "route()");
    const report = await run_(
      gates.hops_resolve,
      envelope({ hops: [hop("t", "caller.ts"), hop("other", "handler.ts")] }),
    );
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(2);
  });

  test("refuses a hop whose file is missing in the repo it names", async () => {
    writeFileSync(path.join(repoRoot, "handler.ts"), "route()");
    // The file exists — in the OTHER repo. Resolving against the named target
    // is the entire point: the same path is true in one tree and false here.
    const report = await run_(gates.hops_resolve, envelope({ hops: [hop("other", "handler.ts")] }));
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("does not exist");
  });

  test("refuses a hop into a repo this run never resolved", async () => {
    const report = await run_(gates.hops_resolve, envelope({ hops: [hop("mobile", "App.swift")] }));
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("not one this run resolved");
  });

  test("refuses an empty trail", async () => {
    const report = await run_(gates.hops_resolve, envelope({ hops: [] }));
    expect(report.passed).toBe(false);
  });
});

describe("options_sound", () => {
  const writeDoc = (body: string): string => {
    const file = path.join(sessionDir, "fixes.md");
    writeFileSync(file, body);
    return file;
  };
  const option = (over: Record<string, unknown> = {}) => ({
    name: "retry the write", target: "t", files: [], pros: ["cheap"], cons: ["masks the bug"],
    effort: "small", ...over,
  });

  test("accepts options whose files exist and a doc that leads with the first", async () => {
    writeFileSync(path.join(otherRoot, "handler.ts"), "route()");
    const doc = writeDoc("# Fixes\n\n## 1. retry the write\n\nbody\n\n## 2. widen the lock\n");
    const report = await run_(
      gates.options_sound,
      envelope({
        artifacts: [doc],
        options: [option({ target: "other", files: ["handler.ts"] }), option({ name: "widen the lock" })],
      }),
    );
    expect(report.passed).toBe(true);
  });

  test("refuses a write-up that opens on an option the envelope ranks second", async () => {
    const doc = writeDoc("## 1. widen the lock\n\nbody\n");
    const report = await run_(
      gates.options_sound,
      envelope({ artifacts: [doc], options: [option(), option({ name: "widen the lock" })] }),
    );
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toContain("the order IS the recommendation");
  });

  test("refuses an option naming a file that is not in the repo it claims", async () => {
    const doc = writeDoc("## 1. retry the write\n");
    const report = await run_(
      gates.options_sound,
      envelope({ artifacts: [doc], options: [option({ files: ["nope.ts"] })] }),
    );
    expect(report.passed).toBe(false);
  });

  test("refuses options with nowhere to read them", async () => {
    const report = await run_(gates.options_sound, envelope({ artifacts: [], options: [option()] }));
    expect(report.passed).toBe(false);
  });
});

/**
 * The ceiling on options is the PARSER's, not a gate's — a fourth option never
 * reaches a gate at all, it fails to parse and re-prompts the same session.
 */
describe("OptionsOutput", () => {
  const option = (name: string) => ({
    name, target: "t", files: [], pros: ["a"], cons: ["b"], effort: "small",
  });
  const base = { status: "success", summary: "", artifacts: [], notes_for_next_agent: "" };

  test("refuses a fourth option", () => {
    const parsed = OptionsOutput.safeParse({ ...base, options: ["a", "b", "c", "d"].map(option) });
    expect(parsed.success).toBe(false);
  });

  test("refuses an option with no stated cost", () => {
    const parsed = OptionsOutput.safeParse({
      ...base,
      options: [{ ...option("a"), cons: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  test("accepts three options, best first", () => {
    const parsed = OptionsOutput.safeParse({ ...base, options: ["a", "b", "c"].map(option) });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.options[0]!.name).toBe("a");
  });
});

/**
 * The difference between a map and a trace is what each is ALLOWED to conclude,
 * and that lives in the schema as much as in the prompt. If `observations` ever
 * gained a `.min(1)`, the cartographer would be in the correlator's position —
 * obliged to produce a finding whether or not one exists — and the workflow
 * would quietly become the thing it was split off to avoid.
 */
describe("MapOutput", () => {
  const base = { status: "success", summary: "the front posts a stage, the api persists it" };

  test("accepts a map that finds nothing worth noting — 'they agree' is an answer", () => {
    const parsed = MapOutput.safeParse({
      ...base,
      hops: [{ target: "t", file: "caller.ts", note: "posts {stage}" }],
      contract: "both sides speak the same OrderStage union",
      observations: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.observations).toEqual([]);
  });

  test("observations may be left out entirely", () => {
    const parsed = MapOutput.safeParse({ ...base, hops: [] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.observations).toEqual([]);
  });

  test("hops still carry their repo — a map is checkable the same way a trace is", async () => {
    writeFileSync(path.join(otherRoot, "handler.ts"), "route()");
    const parsed = MapOutput.parse({
      ...base,
      hops: [{ target: "other", file: "handler.ts", note: "receives it" }],
    });
    // The same gate the trace uses: the claim is verified in the repo it names.
    const report = await run_(gates.hops_resolve, parsed as unknown as EnvelopeBase);
    expect(report.passed).toBe(true);
  });
});
