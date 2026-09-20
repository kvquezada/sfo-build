/**
 * What an agent may CHANGE, verified in code after the fact.
 *
 * Decision 6 is PREVENT + DETECT, and the two halves do different jobs.
 *
 * PREVENT is the harness sandbox, and it is the strong half. Measured: an
 * agent told to `bash -> echo PWNED > <factory>/gates.ts` left the file
 * untouched and replied "Permission denied. I can't write outside the
 * repo/workspace in this environment." That is stronger than SSSF ever got —
 * it stops the write instead of undoing it. It holds ONLY while nothing passes
 * `--allow-all-paths`, `--allow-all` or `--yolo`, which is why agent_copilot.ts
 * never builds those flags.
 *
 * DETECT is this module, and it is the backstop. `tools:` cannot express a
 * boundary on its own: `bash` runs anything and `create` reaches any path, so
 * an agent's capability list is a statement of intent that nothing checks.
 * Two trees are watched, for two different reasons:
 *
 *   the TARGET repo   against the agent's own `writes:` allowlist. Comparing
 *                     change-SETS rather than watching for writes is what
 *                     catches `git checkout -- .`: a path that was dirty
 *                     before the agent ran and is clean afterwards has been
 *                     reverted, and a reversion is a modification.
 *
 *   the FACTORY tree  as a TRIPWIRE. No agent is ever granted it, so any
 *                     change at all means prevention failed. There is no
 *                     allowlist here and no legitimate write — one differing
 *                     byte is a breach.
 *
 * A breach is NOT a gate violation. Gates are for work an agent can be asked to
 * redo; a breach cannot be corrected by re-prompting, because the write already
 * happened. It aborts the phase and names every offending path.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentConfig, SfoConfig } from "./types.ts";

export class PermissionBreach extends Error {}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/** Fingerprints of every path a tree currently differs on, keyed by path. */
export type TreeSnapshot = Record<string, string>;

export interface TwoTreeSnapshot {
  repo: TreeSnapshot;
  factory: TreeSnapshot;
}

/**
 * Fingerprint every path the working tree currently differs on.
 *
 * Tracked files carry their numstat counts, so an edit to an already-dirty file
 * still registers. Untracked files are listed by name. Gitignored paths never
 * appear — which is correct here, because the session runtime lives outside
 * every repo now and cannot collide with one.
 */
export function snapshotTree(repoRoot: string): TreeSnapshot {
  const fingerprints: TreeSnapshot = {};
  for (const line of git(["diff", "HEAD", "--numstat"], repoRoot).split("\n")) {
    const fields = line.split("\t");
    if (fields.length >= 3) {
      const p = (fields[fields.length - 1] ?? "").trim();
      if (p) fingerprints[p] = `${fields[0]},${fields[1]}`;
    }
  }
  for (const line of git(["ls-files", "--others", "--exclude-standard"], repoRoot).split("\n")) {
    const p = line.trim();
    if (p) fingerprints[p] = "untracked";
  }
  // HEAD rides along so a commit made by an agent registers as a change even
  // when it leaves the working tree spotless.
  const head = git(["rev-parse", "HEAD"], repoRoot).trim();
  if (head) fingerprints["#HEAD"] = head;
  return fingerprints;
}

/** Where the factory itself lives — the tree no agent may ever touch. */
export function factoryRoot(): string {
  // adws/adw_modules/permissions.ts -> the repo root two levels up.
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
}

export function snapshot(repoRoot: string): TwoTreeSnapshot {
  return { repo: snapshotTree(repoRoot), factory: snapshotTree(factoryRoot()) };
}

/** Every path whose state differs — appeared, vanished, or was rewritten. */
export function changedPaths(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((p) => before[p] !== after[p]).sort();
}

/**
 * Translate a pattern, with `*` stopping at a path separator.
 *
 * A plain fnmatch would let `*` cross `/`, which quietly widens every pattern:
 * `apps/api/*.ts` would match `apps/api/deep/nested/x.ts` too. `**` is the way
 * to say "cross directories".
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matches(p: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return p.startsWith(pattern); // directory prefix
  if (pattern.includes("*") || pattern.includes("?")) return globToRegExp(pattern).test(p);
  return p === pattern;
}

/**
 * May this agent modify this path in the TARGET repo?
 *
 * `subdir` is folded in here, which is what makes decision 7 work: the agent's
 * cwd is the repo root so a monorepo can be READ across packages, while a
 * scoped target still bounds what may be WRITTEN.
 */
export function permitted(
  p: string,
  agent: AgentConfig,
  cfg: SfoConfig,
  subdir = "",
): boolean {
  if (p === "#HEAD") return true; // commits are made by code phases, not agents
  // Naming a path in `writes:` is what unlocks an otherwise protected one.
  if ((agent.writes ?? []).some((w) => matches(p, w))) {
    return !subdir || p.startsWith(`${subdir.replace(/\/+$/, "")}/`);
  }
  if (cfg.defaults.protected_files.some((w) => matches(p, w))) return false;
  if (agent.writes === null) {
    return !subdir || p.startsWith(`${subdir.replace(/\/+$/, "")}/`);
  }
  return false; // [] = read-only with respect to the repo
}

/**
 * Undo one unauthorized change. Returns a word describing what happened.
 *
 * Only changes the agent INTRODUCED are undone. A path that was already dirty
 * when the agent started is left exactly as it is: the operator had uncommitted
 * work there, and discarding it to tidy up would be the same harm this module
 * exists to prevent, committed by the cleanup instead of the agent. In practice
 * the dirty guard in targets.ts means this branch is rare.
 */
function rollBack(
  repoRoot: string,
  p: string,
  before: TreeSnapshot,
  after: TreeSnapshot,
): string {
  if (p in before) {
    return p in after
      ? "left as-is (was already modified before the agent ran)"
      : "REVERTED-BY-AGENT (uncommitted work lost, cannot restore)";
  }
  if (after[p] === "untracked") {
    try {
      rmSync(path.join(repoRoot, p), { force: true });
      return "deleted";
    } catch (error) {
      return `could not delete (${(error as Error).message})`;
    }
  }
  const out = git(["checkout", "--", p], repoRoot);
  return out === "" ? "rolled back" : "could not roll back";
}

export interface EnforceParams {
  repoRoot: string;
  subdir: string;
  agent: AgentConfig;
  cfg: SfoConfig;
  before: TwoTreeSnapshot;
}

/**
 * Compare both trees against `before`; undo and throw if the agent overstepped.
 *
 * Returns the paths it legitimately changed, so the trace records what an agent
 * actually touched rather than only what it claimed in its envelope.
 */
export function enforce(params: EnforceParams): string[] {
  const after = snapshot(params.repoRoot);

  // ── tripwire first. A factory write means PREVENTION failed, which is a
  // different and more serious fact than an agent writing the wrong file in a
  // repo it was invited into. It is reported on its own terms and never
  // rolled back automatically — the engine's own source is not something this
  // process should be rewriting while it runs.
  const factoryTouched = changedPaths(params.before.factory, after.factory).filter(
    (p) => p !== "#HEAD",
  );
  if (factoryTouched.length) {
    throw new PermissionBreach(
      `TRIPWIRE: ${params.agent.name} changed ${factoryTouched.length} path(s) inside the ` +
        `factory tree at ${factoryRoot()}:\n` +
        factoryTouched.map((p) => `  - ${p}`).join("\n") +
        `\n\nNo agent is ever granted this tree, so the harness sandbox should have ` +
        `refused the write outright. Treat this as a sandbox failure: check that no ` +
        `--allow-all-paths / --allow-all / --yolo flag reached the CLI, and inspect ` +
        `these paths by hand before running anything else.`,
    );
  }

  const touched = changedPaths(params.before.repo, after.repo);
  const breaches = touched.filter(
    (p) => !permitted(p, params.agent, params.cfg, params.subdir),
  );
  if (!breaches.length) return touched.filter((p) => p !== "#HEAD");

  const outcomes = breaches.map(
    (p) => `  - ${p} — ${rollBack(params.repoRoot, p, params.before.repo, after.repo)}`,
  );
  const scope =
    params.agent.writes === null
      ? params.subdir
        ? `scoped to ${params.subdir}/`
        : `barred only from ${JSON.stringify(params.cfg.defaults.protected_files)}`
      : params.agent.writes.length === 0
        ? "read-only"
        : `limited to ${JSON.stringify(params.agent.writes)}`;
  throw new PermissionBreach(
    `${params.agent.name} is ${scope} but modified ${breaches.length} path(s):\n` +
      outcomes.join("\n"),
  );
}

/** Stable id for a tree, used by the doctor to show the tripwire is armed. */
export function treeFingerprint(root: string): string {
  const snap = snapshotTree(root);
  return createHash("sha256").update(JSON.stringify(snap)).digest("hex").slice(0, 12);
}

/** True when the factory tree currently has no uncommitted changes. */
export function factoryClean(): boolean {
  const snap = snapshotTree(factoryRoot());
  return Object.keys(snap).filter((k) => k !== "#HEAD").length === 0;
}

/** Guard used by the doctor: the runtime must not live inside the factory. */
export function assertRuntimeOutsideFactory(dataDir: string): void {
  const runtime = path.resolve(dataDir);
  const factory = factoryRoot();
  if (runtime === factory || runtime.startsWith(`${factory}${path.sep}`)) {
    throw new PermissionBreach(
      `data_dir ${runtime} is inside the factory tree ${factory}.\n\n` +
        `Agents are --add-dir'd into the session directory so they can write ` +
        `handoff artifacts, and --add-dir grants a whole TREE. Put the runtime ` +
        `there and every agent gets write access to the engine and to the ` +
        `prompts that grade it. Move data_dir outside the repo.`,
    );
  }
}

export function ensureFileUnchanged(file: string, expectedSha: string): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  return createHash("sha256").update(readFileSync(file)).digest("hex") === expectedSha;
}
