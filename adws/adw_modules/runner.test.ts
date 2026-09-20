/**
 * A run resolves N repos; a PHASE picks one. These cover that seam.
 *
 * The failure this guards against is quiet rather than loud: a phase that
 * silently reads the run's primary target instead of its own would spawn its
 * agent in the wrong checkout, enforce the wrong write boundary, and resolve
 * its claimed paths against the wrong root — and every one of those would still
 * pass, because the wrong repo is a real repo.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { Run } from "./runner.ts";
import { Tracer } from "./tracer.ts";
import { SfoConfig, type ResolvedTarget } from "./types.ts";

let root: string;
let tracer: Tracer;
let run: Run;

const target = (name: string, repoPath: string): ResolvedTarget => ({
  name, path: repoPath, scope: repoPath, subdir: "",
  test: [], lint: [], typecheck: [], build: [],
  base_branch: "main", remote: "origin",
});

let mobile: ResolvedTarget;
let api: ResolvedTarget;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sfo-runner-"));
  mobile = target("mobile", path.join(root, "ios-app"));
  api = target("api", path.join(root, "backend"));
  for (const t of [mobile, api]) mkdirSync(t.path, { recursive: true });

  tracer = new Tracer(path.join(root, "sfo.db"), path.join(root, "events.jsonl"));
  // phases carry a foreign key to sessions, so the run has to exist first —
  // exactly the order session.ts opens them in.
  tracer.sessionStart({
    adwId: "adw_t",
    engineer: "tester",
    adwName: "adw_trace",
    target: "mobile+api",
    repoPath: `${mobile.path} ${api.path}`,
  });
  run = new Run({
    cfg: SfoConfig.parse({ defaults: { data_dir: path.join(root, "data") } }),
    adwId: "adw_t",
    tracer,
    engineer: "tester",
    targets: [mobile, api],
    promptRoot: path.join(root, "prompts"),
  });
});

afterEach(() => {
  tracer.close();
  rmSync(root, { recursive: true, force: true });
});

describe("targetFor", () => {
  test("an empty name is the run's primary — what every single-target ADW gets", () => {
    expect(run.target.name).toBe("mobile");
    expect(run.targetFor("").name).toBe("mobile");
  });

  test("a named target is the one the phase asked for", () => {
    expect(run.targetFor("api").path).toBe(api.path);
  });

  test("a target this run never resolved is refused, and says what it holds", () => {
    expect(() => run.targetFor("web")).toThrow(/did not resolve.*mobile, api/s);
  });
});

describe("viewFor", () => {
  test("repoRoot follows the view's target, not the run's", () => {
    expect(run.repoRoot).toBe(mobile.path);
    expect(run.viewFor(api).repoRoot).toBe(api.path);
    expect(run.repoRoot).toBe(mobile.path); // the run itself is untouched
  });

  test("everything else is the same run — one session, one trace, one handoff", () => {
    const view = run.viewFor(api);
    expect(view.sessionDir).toBe(run.sessionDir);
    expect(view.adw_id).toBe(run.adw_id);
    expect(view.targets).toBe(run.targets);
    expect(view.tracer).toBe(run.tracer);
  });

  test("a gate reading the view sees every target, so it can check any of them", () => {
    expect(run.viewFor(api).targets.map((t) => t.name)).toEqual(["mobile", "api"]);
  });
});

describe("handoffFor", () => {
  test("each repo gets its own directory, so two scouts cannot overwrite each other", () => {
    const a = run.handoffFor(mobile);
    const b = run.handoffFor(api);
    expect(a).not.toBe(b);
    expect(path.basename(a)).toBe("mobile");
    expect(path.basename(b)).toBe("api");
    for (const dir of [a, b]) {
      expect(existsSync(dir)).toBe(true);
      expect(dir.startsWith(run.contextHandoffDir)).toBe(true);
    }
  });
});

describe("phase", () => {
  test("a phase resolves its own target when it opens", async () => {
    const ph = run.phase({
      name: "scout_api",
      kind: "agent",
      owner: "scout",
      target: "api",
      description: "Find what the backend does with this request",
    });
    expect(ph.target.path).toBe(api.path);
    ph.done();
    await ph[Symbol.asyncDispose]();
  });

  test("a phase naming no target stands in the primary", async () => {
    const ph = run.phase({
      name: "correlate",
      kind: "agent",
      owner: "correlator",
      description: "Join the reports and name the seam",
    });
    expect(ph.target.path).toBe(mobile.path);
    ph.done();
    await ph[Symbol.asyncDispose]();
  });

  test("a phase naming an unresolved target fails before it can spawn anything", () => {
    expect(() =>
      run.phase({
        name: "scout_web",
        kind: "agent",
        owner: "scout",
        target: "web",
        description: "Find what the web app does with this request",
      }),
    ).toThrow(/did not resolve/);
  });
});

/**
 * Two phases open at once — what a concurrent review pair does.
 *
 * The failure these guard against is the quiet kind again. Before phase lanes,
 * `Console` held ONE phase id and filed every line against it, so the second
 * judge's gate results and retries were recorded as the first judge's. Nothing
 * errored; the trace simply described a run that never happened.
 */
describe("concurrent phases", () => {
  const logsFor = (phaseId: string): string[] => {
    const db = new DatabaseSync(path.join(root, "sfo.db"));
    const rows = db
      .prepare("SELECT payload_json FROM events WHERE phase_id = ? AND type = 'log'")
      .all(phaseId) as { payload_json: string }[];
    db.close();
    return rows.map((r) => String(JSON.parse(r.payload_json).message));
  };

  test("each phase's lines are filed against its own phase, not the last one opened", async () => {
    const a = run.phase({ name: "review_1", kind: "agent", owner: "reviewer", description: "Judge the requirements one at a time" });
    const b = run.phase({ name: "adversary_1", kind: "agent", owner: "adversary", description: "Hunt for what nobody asked for" });

    // Interleaved on purpose: b opened last, so an ambient lane would swallow
    // both of these.
    a.console.note("reviewer looked at the dto");
    b.console.note("adversary looked at the service");

    a.done();
    b.done();
    await a[Symbol.asyncDispose]();
    await b[Symbol.asyncDispose]();

    expect(logsFor(a.phase.phase_id).join(" ")).toContain("reviewer looked at the dto");
    expect(logsFor(a.phase.phase_id).join(" ")).not.toContain("adversary looked at the service");
    expect(logsFor(b.phase.phase_id).join(" ")).toContain("adversary looked at the service");
  });

  test("while both are open, every line names its owner", async () => {
    const a = run.phase({ name: "review_1", kind: "agent", owner: "reviewer", description: "Judge the requirements one at a time" });
    const b = run.phase({ name: "adversary_1", kind: "agent", owner: "adversary", description: "Hunt for what nobody asked for" });
    a.console.note("two lanes are open");
    a.done();
    b.done();
    await a[Symbol.asyncDispose]();
    await b[Symbol.asyncDispose]();
    expect(logsFor(a.phase.phase_id).join(" ")).toContain("[reviewer] two lanes are open");
  });

  test("a lone phase is untagged — the default chain reads exactly as it did", async () => {
    const only = run.phase({ name: "review_1", kind: "agent", owner: "reviewer", description: "Judge the requirements one at a time" });
    only.console.note("one lane, no tag");
    only.done();
    await only[Symbol.asyncDispose]();
    expect(logsFor(only.phase.phase_id).join(" ")).toContain("one lane, no tag");
    expect(logsFor(only.phase.phase_id).join(" ")).not.toContain("[reviewer]");
  });

  test("an escaped error names every phase still open, not whichever ran last", async () => {
    const a = run.phase({ name: "review_1", kind: "agent", owner: "reviewer", description: "Judge the requirements one at a time" });
    const b = run.phase({ name: "adversary_1", kind: "agent", owner: "adversary", description: "Hunt for what nobody asked for" });
    run.recordFailure(new Error("the checkout vanished"));
    expect(a.phase.error).toBe("the checkout vanished");
    expect(b.phase.error).toBe("the checkout vanished");
    await a[Symbol.asyncDispose]();
    await b[Symbol.asyncDispose]();
  });

  test("closing one phase does not close the other's lane", async () => {
    const a = run.phase({ name: "review_1", kind: "agent", owner: "reviewer", description: "Judge the requirements one at a time" });
    const b = run.phase({ name: "adversary_1", kind: "agent", owner: "adversary", description: "Hunt for what nobody asked for" });
    a.done();
    await a[Symbol.asyncDispose]();

    b.console.note("still running after the reviewer finished");
    b.done();
    await b[Symbol.asyncDispose]();
    expect(logsFor(b.phase.phase_id).join(" ")).toContain("still running after the reviewer finished");
  });
});
