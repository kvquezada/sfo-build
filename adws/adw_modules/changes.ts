/**
 * Deterministic change capture: what was built, straight from git.
 *
 * "What changed since X" is not a judgement call — it is two git commands and
 * a subtraction. So it is code (hard rule 8), and an agent is only handed the
 * result. The capture writes the full diff into `context_handoff/` and returns
 * a ChangeSet; `asEnvelope` adapts that into the one door every agent handoff
 * uses, so the documenter consumes it exactly as it would another agent's
 * report.
 *
 * The base is RESOLVED, not assumed, and whichever way it went rides along in
 * `BaseRef.reason` — a diff is only as trustworthy as the thing it was taken
 * against, so the trace never leaves a reader to infer it.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import * as git from "./git_helper.ts";
import {
  baseRefLabel,
  type ChangeCapture,
  type ChangesOutput,
  type ChangeSet,
  type BaseRef,
} from "./types.ts";
import type { Run } from "./runner.ts";

const DIFF_FILENAME = "changes.diff";
const DEFAULT_MAX_DIFF_LINES = 2000;

/** Pick the commit the work is measured from, and record why that one. */
export function resolveBase(ref: string, cwd: string): BaseRef {
  if (!git.isRepo(cwd)) {
    throw new Error(`${cwd} is not a git repository — change capture needs one.`);
  }
  if (!git.refExists(ref, cwd)) {
    throw new Error(
      `base ref '${ref}' does not exist in this repository — pass --base with one that does.`,
    );
  }

  const base: BaseRef = { ref, commit: git.mergeBase(ref, cwd), reason: "" };
  const label = baseRefLabel(base);
  if (git.shortSha(base.commit, cwd) !== git.shortSha("HEAD", cwd)) {
    base.reason = `HEAD is ahead of ${label} — diffing every commit since, plus the working tree`;
  } else if (git.isDirty(cwd)) {
    base.reason = `HEAD is on ${label} — diffing the uncommitted working tree`;
  } else if (git.refExists("HEAD~1", cwd)) {
    // "Document the work that was just done" still has an answer right after a
    // chain committed, which is precisely when the documenter runs.
    base.commit = git.rev("HEAD~1", cwd);
    base.reason = `HEAD is on ${label} with a clean tree — falling back to the last commit`;
  } else {
    base.reason = `HEAD is on ${label} with a clean tree and no parent commit`;
  }
  return base;
}

/** Diff the working tree against the resolved base and persist the evidence. */
export function capture(run: Run, params: ChangeCapture): ChangeSet {
  const cwd = run.target.path;
  const maxLines = params.max_diff_lines ?? DEFAULT_MAX_DIFF_LINES;
  const base = resolveBase(params.base, cwd);
  const files = git.diffFiles(base.commit, cwd);
  const untracked = params.include_untracked === false ? [] : git.untrackedFiles(cwd);
  const { insertions, deletions } = git.diffCounts(base.commit, cwd);
  const stat = git.diffStat(base.commit, cwd);

  let text = git.diffText(base.commit, cwd);
  const lines = text.split("\n");
  const truncated = lines.length > maxLines;
  if (truncated) {
    text =
      `${lines.slice(0, maxLines).join("\n")}\n\n` +
      `[truncated at ${maxLines} lines of ${lines.length} — ` +
      `run \`git diff ${base.commit}\` for the rest]`;
  }

  // Untracked files are absent from `git diff` by construction, so they are
  // named here rather than silently missing from the record. The reader has
  // `view` and can open any of them.
  const untrackedBlock = untracked.length
    ? untracked.map((f) => `  ${f}`).join("\n")
    : "  (none)";
  const diffPath = path.join(run.contextHandoffDir, DIFF_FILENAME);
  writeFileSync(
    diffPath,
    `# changes since ${baseRefLabel(base)} @ ${git.shortSha(base.commit, cwd)}\n` +
      `# ${base.reason}\n` +
      `# +${insertions} -${deletions} across ${files.length} tracked file(s)\n\n` +
      `## stat\n${stat || "  (no tracked changes)"}\n\n` +
      `## untracked files\n${untrackedBlock}\n\n` +
      `## diff\n${text}\n`,
  );

  return { base, files, untracked, insertions, deletions, stat, diff_path: diffPath, truncated };
}

export function isEmpty(changes: ChangeSet): boolean {
  return changes.files.length === 0 && changes.untracked.length === 0;
}

/** Wrap a captured change so an agent can be handed it directly. */
export function asEnvelope(changes: ChangeSet, cwd: string, notes = ""): ChangesOutput {
  const total = changes.files.length + changes.untracked.length;
  const label = baseRefLabel(changes.base);
  return {
    status: "success",
    summary:
      `${total} file(s) changed since ${label} ` +
      `(+${changes.insertions} -${changes.deletions})`,
    artifacts: [changes.diff_path],
    notes_for_next_agent: notes,
    base: `${label} @ ${git.shortSha(changes.base.commit, cwd)} — ${changes.base.reason}`,
    changed_files: [...changes.files, ...changes.untracked],
    insertions: changes.insertions,
    deletions: changes.deletions,
    stat: changes.stat,
    diff_path: changes.diff_path,
  };
}
