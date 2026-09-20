/**
 * The DETECT half of decision 6.
 *
 * Prevention is measured elsewhere and works: the Copilot sandbox refuses an
 * out-of-tree write outright ("denied by the environment permissions policy",
 * tool success=false). But prevention is the harness's promise, not ours, and
 * a factory that only checks writes it was told about checks nothing. These
 * tests drive `enforce` against a real git repo with real unauthorized writes,
 * because in every live run so far the agents simply complied — which is the
 * right outcome and the reason the backstop needs testing on its own.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as permissions from "./permissions.ts";
import { AgentConfig, SfoConfig, type AgentConfig as Agent, type SfoConfig as Config } from "./types.ts";

const cfg: Config = SfoConfig.parse({});
const agentOf = (over: Partial<Agent>): Agent => AgentConfig.parse({ name: "t", ...over });

const READ_ONLY = agentOf({ name: "scout", writes: [] });
const UNRESTRICTED = agentOf({ name: "builder", writes: null });
const DOCUMENTER = agentOf({
  name: "documenter",
  writes: ["app_docs/", "docs/", "**/*.md", "*.md"],
});

describe("permitted", () => {
  test("a read-only agent may modify nothing in the repo", () => {
    expect(permissions.permitted("apps/api/src/x.ts", READ_ONLY, cfg)).toBe(false);
    expect(permissions.permitted("README.md", READ_ONLY, cfg)).toBe(false);
  });

  test("an unrestricted agent may modify anything when the target is unscoped", () => {
    expect(permissions.permitted("apps/api/src/x.ts", UNRESTRICTED, cfg)).toBe(true);
    expect(permissions.permitted("libs/shared/src/lib/order.ts", UNRESTRICTED, cfg)).toBe(true);
  });

  test("subdir bounds an unrestricted agent — decision 7's write half", () => {
    expect(permissions.permitted("apps/api/src/x.ts", UNRESTRICTED, cfg, "apps/api")).toBe(true);
    expect(permissions.permitted("apps/front/src/x.ts", UNRESTRICTED, cfg, "apps/api")).toBe(false);
    // The scope is a path prefix, not a string prefix: apps/api-legacy is not
    // inside apps/api, however similar the two names look.
    expect(permissions.permitted("apps/api-legacy/x.ts", UNRESTRICTED, cfg, "apps/api")).toBe(false);
  });

  test("an explicit allowlist entry overrides subdir — specs/ and app_docs/ are repo-level", () => {
    const planner = agentOf({ name: "planner", writes: ["specs/"] });
    expect(permissions.permitted("specs/x.md", planner, cfg, "apps/api")).toBe(true);
    // ...but it is still an allowlist: nothing outside it is granted.
    expect(permissions.permitted("apps/api/src/x.ts", planner, cfg, "apps/api")).toBe(false);
    expect(permissions.permitted("app_docs/x.md", DOCUMENTER, cfg, "apps/api")).toBe(true);
  });

  test("an allowlist admits its own paths and nothing else", () => {
    expect(permissions.permitted("app_docs/note.md", DOCUMENTER, cfg)).toBe(true);
    expect(permissions.permitted("README.md", DOCUMENTER, cfg)).toBe(true);
    expect(permissions.permitted("apps/api/src/readme.md", DOCUMENTER, cfg)).toBe(true);
    expect(permissions.permitted("apps/api/src/x.ts", DOCUMENTER, cfg)).toBe(false);
  });

  test("protected_files bar an agent that has not named them itself", () => {
    const guarded: Config = SfoConfig.parse({ defaults: { protected_files: ["secrets/"] } });
    expect(permissions.permitted("secrets/key.txt", UNRESTRICTED, guarded)).toBe(false);
    const invited = agentOf({ name: "ops", writes: ["secrets/"] });
    expect(permissions.permitted("secrets/key.txt", invited, guarded)).toBe(true);
  });
});

describe("matches", () => {
  test("* stops at a path separator, ** crosses it", () => {
    expect(permissions.matches("adws/adw_plan.ts", "adws/adw_*.ts")).toBe(true);
    // Without this, every `*` pattern silently widens to a `**` one.
    expect(permissions.matches("adws/data/sessions/x.ts", "adws/adw_*.ts")).toBe(false);
    expect(permissions.matches("a/b/c/deep.md", "**/*.md")).toBe(true);
  });

  test("a trailing slash is a directory prefix", () => {
    expect(permissions.matches("docs/a/b.md", "docs/")).toBe(true);
    expect(permissions.matches("docsy/a.md", "docs/")).toBe(false);
  });
});

describe("enforce against a real repo", () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sfo-perm-"));
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    mkdirSync(path.join(repo, "apps", "api"), { recursive: true });
    mkdirSync(path.join(repo, "apps", "front"), { recursive: true });
    writeFileSync(path.join(repo, "apps/api/keep.ts"), "export const a = 1;\n");
    writeFileSync(path.join(repo, "apps/front/keep.ts"), "export const b = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "init");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("an unauthorized NEW file is refused and deleted", () => {
    const before = permissions.snapshot(repo);
    const offending = path.join(repo, "apps/front/breach.ts");
    writeFileSync(offending, "export const BREACH = true;\n");

    expect(() =>
      permissions.enforce({
        repoRoot: repo,
        subdir: "apps/api",
        agent: UNRESTRICTED,
        cfg,
        before,
      }),
    ).toThrow(permissions.PermissionBreach);

    // Detection alone would leave the repo holding the change while reporting
    // a failure, so anything the agent INTRODUCED outside its scope is undone.
    expect(existsSync(offending)).toBe(false);
  });

  test("an unauthorized EDIT to a tracked file is refused and rolled back", () => {
    const before = permissions.snapshot(repo);
    const victim = path.join(repo, "apps/front/keep.ts");
    writeFileSync(victim, "export const b = 999; // tampered\n");

    expect(() =>
      permissions.enforce({ repoRoot: repo, subdir: "apps/api", agent: UNRESTRICTED, cfg, before }),
    ).toThrow(/modified 1 path/);

    expect(Bun.file(victim).text()).resolves.toBe("export const b = 2;\n");
  });

  test("a REVERSION counts as a modification", () => {
    // The `git checkout -- .` case: SSSF shipped a builder that discarded the
    // operator's uncommitted work to tidy up before being graded. A path that
    // was dirty before the agent ran and is clean afterwards has been changed,
    // and comparing change-SETS is what catches it.
    const victim = path.join(repo, "apps/front/keep.ts");
    writeFileSync(victim, "export const b = 3; // operator's work in progress\n");
    const before = permissions.snapshot(repo);
    git("checkout", "--", "apps/front/keep.ts"); // the agent "tidying up"

    expect(() =>
      permissions.enforce({ repoRoot: repo, subdir: "apps/api", agent: UNRESTRICTED, cfg, before }),
    ).toThrow(/REVERTED-BY-AGENT/);
  });

  test("an in-scope write passes and is reported as touched", () => {
    const before = permissions.snapshot(repo);
    writeFileSync(path.join(repo, "apps/api/new.ts"), "export const c = 3;\n");

    const touched = permissions.enforce({
      repoRoot: repo,
      subdir: "apps/api",
      agent: UNRESTRICTED,
      cfg,
      before,
    });
    expect(touched).toContain("apps/api/new.ts");
  });

  test("a read-only agent that writes anything is refused", () => {
    const before = permissions.snapshot(repo);
    writeFileSync(path.join(repo, "notes.md"), "scout was here\n");

    expect(() =>
      permissions.enforce({ repoRoot: repo, subdir: "", agent: READ_ONLY, cfg, before }),
    ).toThrow(/read-only/);
  });

  test("the factory tripwire fires before any repo check, and never rolls back", () => {
    // Simulated by doctoring the BEFORE snapshot rather than writing into the
    // real factory: the assertion is that a difference in that tree aborts the
    // phase on its own terms, which is a sandbox failure, not an agent mistake.
    const before = permissions.snapshot(repo);
    before.factory = { ...before.factory, "adws/adw_modules/gates.ts": "0,0" };

    expect(() =>
      permissions.enforce({ repoRoot: repo, subdir: "", agent: UNRESTRICTED, cfg, before }),
    ).toThrow(/TRIPWIRE/);
  });
});

describe("the factory/runtime split", () => {
  test("a runtime inside the factory tree is refused", () => {
    const inside = path.join(permissions.factoryRoot(), "adws", "adw_data");
    expect(() => permissions.assertRuntimeOutsideFactory(inside)).toThrow(/inside the factory tree/);
  });

  test("the real runtime location is accepted", () => {
    expect(() =>
      permissions.assertRuntimeOutsideFactory(path.join(process.env["HOME"]!, ".sfo-build")),
    ).not.toThrow();
  });
});
