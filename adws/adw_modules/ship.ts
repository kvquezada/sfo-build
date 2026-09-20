/**
 * The last mile: cut a branch, push it, open the pull request.
 *
 * Shared, the way quality.ts and changes.ts are shared, so `npm run ship` and
 * the `--ship` step on a longer chain are one implementation rather than two
 * that drift.
 *
 * Every phase here is `kind: "code"` — hard rule 8. git and gh are known
 * commands; no agent rediscovers them. There is a second reason beyond the
 * rule: permissions.ts fingerprints the tree and `#HEAD`, but not the branch
 * HEAD points at (`permitted` waves `#HEAD` through unconditionally, because
 * commits come from code phases). An agent switching branches would slip the
 * tripwire entirely. Code phases keep that from ever being a question.
 *
 * The chains commit onto whatever branch is checked out, which today is the
 * trunk. So the honest range for "what this run produced" is
 * `<remote>/<base>..HEAD`, never `<base>..HEAD` — the latter is empty exactly
 * when you are standing on the base branch, which is the normal case.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as gh from "./gh_helper.ts";
import * as git from "./git_helper.ts";
import { render } from "./prompts.ts";
import { ensureDir } from "./utils.ts";
import type { Run } from "./runner.ts";

export class ShipError extends Error {}

/** The factory's own template, when the operator names no other. */
export const DEFAULT_TEMPLATE = path.join(
  path.dirname(path.dirname(new URL(import.meta.url).pathname)),
  "adw_data",
  "templates",
  "pull_request.md",
);

export interface ShipOptions {
  /** Override the derived branch name. */
  branch?: string | undefined;
  /** Override the PR body template. */
  template?: string | undefined;
  /** Open the PR as a draft. */
  draft?: boolean | undefined;
  /** Branch and push, but open no PR. */
  noPr?: boolean | undefined;
  /** Leave the local base branch where the run left it. */
  noRewind?: boolean | undefined;
  /** Derive and render everything, touch nothing. */
  dryRun?: boolean | undefined;
}

export interface ShipResult {
  branch: string;
  title: string;
  base: string;
  remote: string;
  subjects: string[];
  pushed: boolean;
  rewound: boolean;
  pr_url: string | null;
}

/** Read the flags this module understands off a chain's parsed argv. */
export function optionsFrom(flags: Record<string, string | boolean>): ShipOptions {
  const str = (key: string): string | undefined =>
    typeof flags[key] === "string" ? (flags[key] as string) : undefined;
  return {
    branch: str("branch"),
    template: str("template"),
    draft: flags["draft"] === true,
    noPr: flags["no-pr"] === true,
    noRewind: flags["no-rewind"] === true,
    dryRun: flags["dry-run"] === true,
  };
}

/** Bullet list of the commits, for the template. */
function commitList(subjects: string[]): string {
  return subjects.map((s) => `- ${s}`).join("\n");
}

/** Links to whatever write-up the documenter left in the range. */
function documentLinks(files: string[]): string {
  const docs = files.filter((f) => f.endsWith(".md"));
  if (!docs.length) return "_No write-up in this range._";
  return docs.map((f) => `- \`${f}\``).join("\n");
}

function renderBody(
  run: Run,
  options: ShipOptions,
  facts: {
    branch: string;
    base: string;
    remote: string;
    title: string;
    subjects: string[];
    range: string;
  },
): string {
  const template = options.template ?? DEFAULT_TEMPLATE;
  if (!existsSync(template)) {
    throw new ShipError(
      `pull request template not found: ${template}\n\n` +
        `The default lives at ${DEFAULT_TEMPLATE} and is yours to edit.`,
    );
  }
  const repo = run.target.path;
  const files = git.diffFiles(facts.range, repo);
  const counts = git.diffCounts(facts.range, repo);
  return render(template, {
    title: facts.title,
    commits: commitList(facts.subjects),
    // git indents every stat line but the first, which the shared git() trim
    // strips. Re-indent so the fenced block lines up.
    stat: git
      .diffStat(facts.range, repo)
      .split("\n")
      .map((line) => (line.startsWith(" ") ? line : ` ${line}`))
      .join("\n"),
    files: files.map((f) => `- \`${f}\``).join("\n"),
    file_count: String(files.length),
    insertions: String(counts.insertions),
    deletions: String(counts.deletions),
    docs: documentLinks(files),
    adw_id: run.adw_id,
    target: run.target.name,
    base: facts.base,
    branch: facts.branch,
    remote: facts.remote,
  });
}

/**
 * Run the ship phases against whatever is already committed.
 *
 * Returns the result rather than an exit code: a standalone chain turns it into
 * one, and a longer chain folds it into a verdict it has already started
 * forming.
 */
export async function ship(run: Run, options: ShipOptions = {}): Promise<ShipResult> {
  const repo = run.target.path;
  const base = run.target.base_branch;
  const remote = run.target.remote;
  const dry = options.dryRun === true;

  let branch = "";
  let title = "";
  let subjects: string[] = [];
  let range = "";
  let createdHere = false;
  let startedOnBase = false;

  {
    await using ph = run.phase({
      name: "branch",
      kind: "code",
      owner: "git",
      description: "Name a branch after the commits this run produced, and stand on it",
    });

    if (!git.isRepo(repo)) {
      throw new ShipError(`${repo} is not a git repository — a ship phase needs one.`);
    }
    if (!git.remoteExists(remote, repo)) {
      throw new ShipError(
        `target '${run.target.name}' has no remote '${remote}'.\n\n` +
          `    git -C ${repo} remote add ${remote} <url>\n\n` +
          `Or point the registry at the one it does have:\n\n` +
          `  - name: ${run.target.name}\n` +
          `    remote: <name>\n`,
      );
    }

    git.fetchRef(remote, base, repo);
    range = `${remote}/${base}`;
    if (!git.refExists(range, repo)) {
      throw new ShipError(
        `'${range}' does not exist after fetching.\n\n` +
          `target '${run.target.name}' declares base_branch: ${base} — ` +
          `check that against the branch the remote actually has.`,
      );
    }

    subjects = git.subjectsSince(range, repo);
    if (!subjects.length) {
      throw new ShipError(
        `nothing to ship — HEAD has no commits that ${range} does not already have.\n\n` +
          `A ship run pushes work that is already committed. Run a chain that ` +
          `commits first, or check you are on the right target.`,
      );
    }

    const derived = git.branchFor(subjects, run.adw_id);
    title = derived.title;

    const current = git.currentBranch(repo);
    startedOnBase = current === base;
    if (options.branch) {
      branch = options.branch;
      createdHere = true;
    } else if (!startedOnBase) {
      // Already standing on a feature branch: that is the operator's choice,
      // and renaming it underneath them would be rude.
      branch = current;
      createdHere = false;
    } else {
      branch = git.uniqueBranchName(derived, run.adw_id, remote, repo);
      createdHere = true;
    }

    ph.log({
      base: `${remote}/${base}`,
      commits: subjects.length,
      branch,
      title,
      action: dry ? "dry-run" : createdHere ? "create" : "reuse",
    });
    if (!dry && createdHere) git.createBranch(branch, repo);
    ph.done();
  }

  const body = renderBody(run, options, { branch, base, remote, title, subjects, range });
  const bodyFile = path.join(ensureDir(path.join(run.sessionDir, "ship")), "pull_request.md");
  writeFileSync(bodyFile, body);

  if (dry) {
    await using ph = run.phase({
      name: "dry_run",
      kind: "code",
      owner: "git",
      description: "Show the branch, title and body a real run would produce, and stop",
    });
    ph.log({ branch, title, base, remote, body: bodyFile });
    run.console.note(`\n${body}\n`);
    ph.done();
    return {
      branch, title, base, remote, subjects,
      pushed: false, rewound: false, pr_url: null,
    };
  }

  {
    await using ph = run.phase({
      name: "push",
      kind: "code",
      owner: "git",
      description: "Put the branch on the remote, with upstream set",
    });
    git.push(remote, branch, repo);
    ph.log({ remote, branch, head: git.shortSha("HEAD", repo) });
    ph.done();
  }

  // Only now is the rewind safe: every commit the base ref moves off is
  // reachable from the branch that was just pushed.
  let rewound = false;
  if (startedOnBase && createdHere && !options.noRewind) {
    await using ph = run.phase({
      name: "rewind",
      kind: "code",
      owner: "git",
      description: "Return the local trunk to the remote, now the work lives on a pushed branch",
    });
    git.resetBranchToRemote(base, remote, repo);
    rewound = true;
    ph.log({ branch: base, now: git.shortSha(`${remote}/${base}`, repo), reason: "pushed" });
    ph.done();
  }

  let prUrl: string | null = null;
  if (!options.noPr) {
    await using ph = run.phase({
      name: "pull_request",
      kind: "code",
      owner: "gh",
      description: "Open the pull request, with a body rendered from the operator's template",
    });
    gh.assertReady();
    const existing = gh.prView(branch, repo);
    if (existing) {
      // A re-run against a branch that already has a PR is a push, not a
      // second PR. The push above already updated it.
      prUrl = existing;
      ph.log({ pr: existing, action: "updated" });
    } else {
      prUrl = gh.prCreate({
        base,
        head: branch,
        title,
        bodyFile,
        draft: options.draft === true,
        cwd: repo,
      });
      ph.log({ pr: prUrl, action: "created", draft: Boolean(options.draft) });
    }
    ph.done();
  }

  return { branch, title, base, remote, subjects, pushed: true, rewound, pr_url: prUrl };
}
