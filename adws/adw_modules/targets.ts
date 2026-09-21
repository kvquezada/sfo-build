/**
 * Resolve `--target NAME` to a real repo on disk, then defend it.
 *
 * Decision 5: work happens IN PLACE — no worktrees. That is the cheapest thing
 * that can possibly work, and it is only safe because of the two guards here:
 *
 *   dirty guard   a run refuses to start on a repo with uncommitted work, so
 *                 permissions.ts can attribute every change to the agent and
 *                 an operator never loses a half-finished edit to a rollback.
 *   path lock     two runs against the same PATH refuse to overlap. Keyed on
 *                 the resolved path, not the target name, because `api` and
 *                 `front` are two rows pointing at one oms checkout — sharing
 *                 a tree is exactly the case a name-keyed lock would miss.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ResolvedTarget, SfoConfig } from "./types.ts";
import { absolute, expandHome, nowIso } from "./utils.ts";

export class TargetError extends Error {}
export class DirtyRepoError extends TargetError {}
export class LockedRepoError extends TargetError {}

export function resolveTarget(cfg: SfoConfig, name: string): ResolvedTarget {
  const row = cfg.targets.find((t) => t.name === name);
  if (!row) {
    throw new TargetError(
      `target '${name}' is not in the registry — available: ` +
        `${cfg.targets.map((t) => t.name).join(", ") || "(none)"}`,
    );
  }
  const repoPath = absolute(row.path);
  if (!existsSync(repoPath)) {
    throw new TargetError(`target '${name}': path does not exist: ${repoPath}`);
  }
  const scope = row.subdir ? path.join(repoPath, row.subdir) : repoPath;
  if (row.subdir && !existsSync(scope)) {
    throw new TargetError(
      `target '${name}': subdir '${row.subdir}' does not exist under ${repoPath}`,
    );
  }
  return {
    name: row.name,
    path: repoPath,
    scope,
    subdir: row.subdir,
    test: row.test,
    lint: row.lint,
    typecheck: row.typecheck,
    build: row.build,
    base_branch: row.base_branch,
    remote: row.remote,
    brief: row.brief || row.name,
  };
}

export function listTargets(cfg: SfoConfig): string[] {
  return cfg.targets.map((t) => t.name);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Refuse to run against a repo that already has uncommitted work.
 *
 * This is the failure the risk table flagged for P3+: it must fail FAST and
 * say exactly what is dirty, because the fix is a human decision (commit,
 * stash, or discard) and no message that just says "repo is dirty" helps.
 */
export function assertClean(target: ResolvedTarget): void {
  let porcelain: string;
  try {
    porcelain = git(["status", "--porcelain"], target.path);
  } catch (error) {
    throw new TargetError(
      `target '${target.name}': ${target.path} is not a git repository ` +
        `(git status failed: ${(error as Error).message.trim()})`,
    );
  }
  if (!porcelain) return;
  const lines = porcelain.split("\n").filter(Boolean);
  const shown = lines.slice(0, 20).map((l) => `    ${l}`).join("\n");
  const more = lines.length > 20 ? `\n    … and ${lines.length - 20} more` : "";
  throw new DirtyRepoError(
    `target '${target.name}' (${target.path}) has ${lines.length} uncommitted change(s):\n` +
      `${shown}${more}\n\n` +
      `A run works IN PLACE, and it must be able to tell its own writes from ` +
      `yours — that is what lets an out-of-scope write be rolled back safely. ` +
      `Commit, stash, or discard first.`,
  );
}

// ── the path lock ────────────────────────────────────────────────────────────

export interface LockInfo {
  pid: number;
  adw_id: string;
  target: string;
  repo_path: string;
  acquired_at: string;
}

function lockPath(cfg: SfoConfig, repoPath: string): string {
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 16);
  return path.join(expandHome(cfg.defaults.data_dir), "locks", `${hash}.json`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 probes without delivering anything
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the lock for this repo path, or refuse.
 *
 * Returns a Disposable, so the caller writes `using lock = acquireLock(...)`
 * and the lock is released on every path out — including a throw. A lock whose
 * owning pid is gone is stale (the run was killed -9 and never unwound); it is
 * reported and reclaimed rather than blocking the tree forever.
 */
export function acquireLock(
  cfg: SfoConfig,
  target: ResolvedTarget,
  adwId: string,
): Disposable & { path: string } {
  const file = lockPath(cfg, target.path);
  mkdirSync(path.dirname(file), { recursive: true });

  if (existsSync(file)) {
    let held: LockInfo | null = null;
    try {
      held = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
    } catch {
      held = null; // unreadable lock file is as good as stale
    }
    if (held && processAlive(held.pid)) {
      throw new LockedRepoError(
        `${target.path} is locked by a run already in flight:\n` +
          `    adw_id  ${held.adw_id}\n` +
          `    target  ${held.target}\n` +
          `    pid     ${held.pid}\n` +
          `    since   ${held.acquired_at}\n\n` +
          `Concurrent runs on one repo path are refused (known impossibility 8) — ` +
          `they work in place and would interleave edits. Wait for it, or kill ` +
          `pid ${held.pid}.`,
      );
    }
    unlinkSync(file); // stale: owning process is gone
  }

  // Exclusive create: two runs racing this line, one of them loses.
  const info: LockInfo = {
    pid: process.pid,
    adw_id: adwId,
    target: target.name,
    repo_path: target.path,
    acquired_at: nowIso(),
  };
  try {
    const fd = openSync(file, "wx");
    closeSync(fd);
    writeFileSync(file, JSON.stringify(info, null, 2));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockedRepoError(
        `${target.path} was locked by another run a moment ago — retry once it finishes.`,
      );
    }
    throw error;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only ever remove OUR lock: a stale-reclaim by a third run must not be
      // undone by this one's cleanup.
      const current = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
      if (current.pid === process.pid && current.adw_id === adwId) unlinkSync(file);
    } catch {
      // already gone, or unreadable — nothing to release
    }
  };

  return {
    path: file,
    [Symbol.dispose]: release,
  };
}
