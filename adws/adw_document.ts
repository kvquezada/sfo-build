#!/usr/bin/env bun
/**
 * ADW Document — write up work that already happened, from its diff.
 *
 *   npm run document -- --target api [--base main] "document the pagination work"
 *
 * Phases: engineer(request) -> code(changes) -> documenter
 *
 * This runs AFTER a build, and the guard is structural rather than advisory:
 * capturing the change is a code phase, and an empty diff throws there, before
 * the documenter is ever spawned. There is nothing to document until something
 * was built, and a subprocess can say so for free instead of an agent
 * discovering it at model prices.
 *
 * `--base` names the ref the work is measured from (main by default).
 * `changes.resolveBase` decides what that means on a branch, on main, and on a
 * clean tree right after a chain committed — and records WHICH it was in
 * `base.reason`, because a diff is only as trustworthy as the thing it was
 * taken against.
 *
 * Two things this chain deliberately does not do:
 *
 *   It does not require a clean tree. Documenting after a build means the build
 *   is in the tree — often uncommitted. The permission backstop compares
 *   change-SETS before and after, so it still tells the documenter's writes
 *   from the engineer's, and `writes:` still bounds it to markdown.
 *
 *   It does not commit. A standalone documenting run has no idea what else is
 *   sitting uncommitted beside it, and `git.commitAll` would sweep all of it
 *   into a commit labelled as docs. `npm run sdlc` commits its write-up because
 *   it committed the code first and knows the tree is otherwise clean.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import { adw, main } from "./adw_modules/session.ts";
import * as changes from "./adw_modules/changes.ts";
import * as gates from "./adw_modules/gates.ts";
import { DocumentOutput } from "./adw_modules/types.ts";

const REQUIRED_AGENTS = ["documenter"];
const DEFAULT_BASE = "main";
const DOCS_DIR = "app_docs";

const DOCUMENT_NOTES =
  "Read diff_path in full before writing. Document only what the diff shows, " +
  "then write it into app_docs/ as your task describes.";

main(
  adw({
    name: "adw_document",
    requiredAgents: REQUIRED_AGENTS,
    argv: process.argv.slice(2),
    requireCleanRepo: false,
    body: async (run, args) => {
      const repo = run.target.path;
      const base = args.base ?? DEFAULT_BASE;

      {
        await using ph = run.phase({
          name: "request",
          kind: "engineer",
          owner: run.engineer,
          description: "Capture the incoming ask and the ref the write-up is measured from",
        });
        ph.log({ input: args.prompt, target: run.target.name, base });
        ph.done();
      }

      let changeset;
      {
        await using ph = run.phase({
          name: "changes",
          kind: "code",
          owner: "git",
          description: `Diff the working tree against ${base} — the change to be written up`,
        });
        changeset = changes.capture(run, { base });
        ph.log({
          base: `${changeset.base.ref} @ ${changeset.base.commit.slice(0, 7)}`,
          reason: changeset.base.reason,
          files: changeset.files.length + changeset.untracked.length,
          lines: `+${changeset.insertions} -${changeset.deletions}`,
          diff: changeset.diff_path,
        });
        if (changes.isEmpty(changeset)) {
          throw new Error(
            `nothing changed since ${base} (${changeset.base.reason}) — documenting ` +
              `runs after a build. Build something first, or point --base at the ref ` +
              `the work should be measured from.`,
          );
        }
        // `mkdir -p app_docs` is a known command, so code runs it (hard rule
        // 8). It also removes the documenter's only reason to need a shell
        // before it can write anything: `create` does not make parent
        // directories, and a missing one sent a real run's write-up into
        // COPILOT_HOME instead of the repo.
        mkdirSync(path.join(repo, DOCS_DIR), { recursive: true });
        ph.log({ docs_dir: DOCS_DIR });
        ph.done();
      }

      {
        await using ph = run.phase({
          name: "document",
          kind: "agent",
          owner: "documenter",
          description: "Turn the captured diff into a write-up an engineer can read",
          retries: 1,
        });
        await ph.call({
          outputType: DocumentOutput,
          outputTypeName: "DocumentOutput",
          prompt: args.prompt,
          previous: changes.asEnvelope(changeset, repo, DOCUMENT_NOTES),
          // file_in_repo is the one that matters here: a write-up that is not
          // in the repo is not a work product, however real the file is.
          gates: [gates.artifacts_exist, gates.files_non_empty, gates.file_in_repo("document_path")],
        });
        ph.done();
      }

      return run.finish();
    },
  }),
);
