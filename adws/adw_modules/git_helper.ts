/**
 * Low-level git operations for code phases.
 *
 * Every function takes the repo root explicitly. SSSF's version read an
 * implicit process cwd, which was safe only because it drove one repo; a
 * factory that drives many must never guess which one it is talking to.
 */

import { execFileSync } from "node:child_process";

export class GitError extends Error {}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || (error as Error).message}`);
  }
}

/** True when `ref` resolves to a commit. Never throws — this is a question. */
export function refExists(ref: string, cwd: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

export function isRepo(cwd: string): boolean {
  try {
    git(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}

export function rev(ref: string, cwd: string): string {
  return git(["rev-parse", ref], cwd);
}

export function shortSha(ref: string, cwd: string): string {
  return git(["rev-parse", "--short", ref], cwd);
}

export function currentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export function isDirty(cwd: string): boolean {
  return git(["status", "--porcelain"], cwd).length > 0;
}

export function untrackedFiles(cwd: string): string[] {
  return git(["ls-files", "--others", "--exclude-standard"], cwd).split("\n").filter(Boolean);
}

/**
 * The commit where `ref` and HEAD diverged — the honest base of a branch.
 *
 * On the base branch itself this returns HEAD, which makes the diff exactly
 * "what is not committed yet". Off it, the diff is the whole branch plus the
 * working tree. One command covers both cases, so no ADW has to branch on it.
 */
export function mergeBase(ref: string, cwd: string, other = "HEAD"): string {
  return git(["merge-base", ref, other], cwd);
}

export function diffFiles(base: string, cwd: string): string[] {
  return git(["diff", "--name-only", base], cwd).split("\n").filter(Boolean);
}

export function diffStat(base: string, cwd: string): string {
  return git(["diff", "--stat", base], cwd);
}

/** (insertions, deletions) across the diff. Binary files count as neither. */
export function diffCounts(base: string, cwd: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of git(["diff", "--numstat", base], cwd).split("\n")) {
    const [added, removed] = line.split("\t");
    if (added && /^\d+$/.test(added)) insertions += Number(added);
    if (removed && /^\d+$/.test(removed)) deletions += Number(removed);
  }
  return { insertions, deletions };
}

export function diffText(base: string, cwd: string): string {
  return git(["diff", base], cwd);
}

export function changedFiles(cwd: string): string[] {
  return git(["status", "--porcelain"], cwd)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
}

/**
 * Stage the working tree and commit it. Returns the new short sha.
 *
 * Refuses an empty commit loudly: "nothing to commit" after a build phase means
 * the preceding phases changed no files, which is a failure the chain needs to
 * hear about rather than a no-op to step over.
 */
export function commitAll(message: string, cwd: string): string {
  if (!isRepo(cwd)) {
    throw new GitError(
      `${cwd} is not a git repository — a commit phase needs one.`,
    );
  }
  git(["add", "-A"], cwd);
  if (!git(["status", "--porcelain"], cwd)) {
    throw new GitError("nothing to commit — the preceding phases changed no files");
  }
  git(["commit", "-m", message], cwd);
  return git(["rev-parse", "--short", "HEAD"], cwd);
}
