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

/** `<type>[(scope)][!]: <description>` — the Conventional Commits v1.0.0 subject. */
const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?: .+/;

/**
 * Reduce an agent's proposed message to one Conventional Commits subject.
 *
 * Every commit this factory makes is a subject and nothing else: no body, no
 * footers. An agent asked for one line sometimes writes three, so the rule is
 * enforced here rather than hoped for in seven call sites — the first non-empty
 * line wins and the rest is dropped.
 *
 * A subject that does not already carry a type is given `chore`. That is a
 * guess, but a conforming guess beats a commit history that only mostly parses;
 * the prompts ask each agent for the honest type, and this catches the ones
 * that forget.
 */
export function subjectLine(message: string): string {
  const first = message.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return CONVENTIONAL.test(first) ? first : `chore: ${first}`;
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
  git(["commit", "-m", subjectLine(message)], cwd);
  return git(["rev-parse", "--short", "HEAD"], cwd);
}

// ── the remote, and the branch a ship run cuts ───────────────────────────────

/** True when `remote` is configured here. Never throws — this is a question. */
export function remoteExists(remote: string, cwd: string): boolean {
  try {
    return git(["remote"], cwd).split("\n").includes(remote);
  } catch {
    return false;
  }
}

/** Update one remote-tracking ref. The range a ship run reads depends on it. */
export function fetchRef(remote: string, ref: string, cwd: string): void {
  git(["fetch", remote, ref], cwd);
}

/** Subjects of the commits in `ref..HEAD`, oldest first. */
export function subjectsSince(ref: string, cwd: string): string[] {
  return git(["log", "--reverse", "--format=%s", `${ref}..HEAD`], cwd)
    .split("\n")
    .filter(Boolean);
}

export function createBranch(name: string, cwd: string): void {
  git(["switch", "-c", name], cwd);
}

/** Push `branch` and set it as upstream. Returns git's own report. */
export function push(remote: string, branch: string, cwd: string): string {
  return git(["push", "-u", remote, branch], cwd);
}

/**
 * Move a local branch ref onto its remote counterpart, discarding nothing.
 *
 * ship.ts calls this only after a successful push, so every commit the ref is
 * moved off is reachable from the pushed branch. Outside that guard it would
 * be a way to lose work.
 */
export function resetBranchToRemote(branch: string, remote: string, cwd: string): void {
  git(["branch", "-f", branch, `${remote}/${branch}`], cwd);
}

// ── deriving the branch name from the commits ────────────────────────────────

/** `<type>[(scope)][!]: <description>` split into its type and description. */
const PARTS = /^([a-z]+)(\([^)]+\))?(!)?: (.+)$/;

/**
 * Conventional type -> branch prefix, in precedence order.
 *
 * A run that added a feature and documented it is a feature; one that fixed a
 * bug and documented it is a fix. The write-up never names the branch, which is
 * why this is an ordered list and not a lookup — the first type present wins.
 */
const PREFIXES: ReadonlyArray<{ types: string[]; prefix: string }> = [
  { types: ["feat"], prefix: "feature" },
  { types: ["fix"], prefix: "fix" },
];
const FALLBACK_PREFIX = "chore";

const MAX_SLUG = 48;

/** Lowercase, alphanumeric, dash-separated, and short enough to read. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip the accents NFKD just split off
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= MAX_SLUG) return slug;
  // Cut on a word boundary when there is one, so the tail is not a half word.
  const cut = slug.slice(0, MAX_SLUG);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > MAX_SLUG / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

export interface DerivedBranch {
  /** `feature` | `fix` | `chore`. */
  prefix: string;
  slug: string;
  /** `<prefix>/<slug>`. */
  name: string;
  /**
   * The subject the name came from, verbatim and still carrying its type.
   *
   * ship.ts uses it as the PR title: a squash-merge then lands a conventional
   * subject on the trunk, which is the rule this repo enforces on its commits.
   */
  title: string;
}

/**
 * Name a branch after the commits it carries.
 *
 * Deterministic on purpose. The branch name is a fact about the commits, and
 * the commits already state their type and their subject — asking a model to
 * restate them would add a call, a failure mode and a second opinion nobody
 * needs. Hard rule 8: a known command is code, not an agent.
 *
 * The PRIMARY commit is the first one of the winning type, not the first one
 * overall. `docs: …` landing before `feat: …` must not name the branch.
 */
export function branchFor(subjects: string[], adwId: string): DerivedBranch {
  const parsed = subjects
    .map((subject) => ({ subject, match: PARTS.exec(subject) }))
    .filter((entry): entry is { subject: string; match: RegExpExecArray } => entry.match !== null);

  let primary = parsed[0];
  let prefix = FALLBACK_PREFIX;
  for (const candidate of PREFIXES) {
    const hit = parsed.find((entry) => candidate.types.includes(entry.match[1]!));
    if (hit) {
      primary = hit;
      prefix = candidate.prefix;
      break;
    }
  }

  // Nothing conventional to read: fall back to the first subject as written,
  // and to the adw_id when even that is missing.
  const title = primary?.subject ?? subjects[0] ?? `chore: ${adwId}`;
  const description = primary?.match[4] ?? subjects[0] ?? adwId;
  const slug = slugify(description) || adwId;
  return { prefix, slug, name: `${prefix}/${slug}`, title };
}

/**
 * The same name, made unique against the branches that already exist.
 *
 * A second run on the same subject is a real case — a revision, a retry — and
 * it must not collide with the branch the first one pushed.
 */
export function uniqueBranchName(
  derived: DerivedBranch,
  adwId: string,
  remote: string,
  cwd: string,
): string {
  const taken = (name: string): boolean =>
    refExists(name, cwd) || refExists(`${remote}/${name}`, cwd);
  if (!taken(derived.name)) return derived.name;
  return `${derived.name}-${adwId}`;
}
