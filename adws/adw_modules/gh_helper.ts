/**
 * The GitHub CLI, for the one phase that opens a pull request.
 *
 * Same shape as git_helper.ts — an argv array through execFileSync, no shell,
 * the repo root passed explicitly — for the same reason: a factory that drives
 * many repos must never guess which one it is talking to.
 *
 * Authentication is the operator's, not the factory's. `operatorEnv()` copies
 * the environment verbatim, so a `gh` logged in at the terminal is logged in
 * here, and a factory that has never been given a token cannot push a PR from
 * an identity the operator did not choose.
 */

import { execFileSync } from "node:child_process";

import { operatorEnv } from "./utils.ts";

export class GhError extends Error {}

function gh(args: string[], cwd: string): string {
  try {
    return execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: operatorEnv(),
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const err = error as { stderr?: string; code?: string };
    if (err.code === "ENOENT") {
      throw new GhError(
        "the GitHub CLI is not installed — a pull request phase needs it.\n\n" +
          "    brew install gh && gh auth login",
      );
    }
    throw new GhError(
      `gh ${args.join(" ")} failed: ${err.stderr?.trim() || (error as Error).message}`,
    );
  }
}

/** True when `gh` is on PATH at all. Never throws — this is a question. */
export function available(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore", env: operatorEnv() });
    return true;
  } catch {
    return false;
  }
}

/** True when `gh` can speak for a real account. Never throws. */
export function authenticated(): boolean {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore", env: operatorEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail now, with the command that fixes it, rather than at `gh pr create`.
 *
 * The quality.specFor precedent: a missing prerequisite is a hard error at the
 * call site carrying a copy-pasteable fix, never a silent skip.
 */
export function assertReady(): void {
  if (!available()) {
    throw new GhError(
      "the GitHub CLI is not installed — a pull request phase needs it.\n\n" +
        "    brew install gh && gh auth login\n\n" +
        "Or run the chain with --no-pr to branch and push without opening one.",
    );
  }
  if (!authenticated()) {
    throw new GhError(
      "the GitHub CLI is installed but not logged in.\n\n" +
        "    gh auth login\n\n" +
        "The factory uses your own gh credentials and holds none of its own.",
    );
  }
}

/** The URL of the open PR for `branch`, or null when there is none. */
export function prView(branch: string, cwd: string): string | null {
  try {
    const out = gh(
      ["pr", "view", branch, "--json", "url", "--jq", ".url"],
      cwd,
    );
    return out || null;
  } catch {
    // `gh pr view` exits non-zero when no PR exists, which is an answer.
    return null;
  }
}

export interface PrRequest {
  base: string;
  head: string;
  title: string;
  /** Path to the rendered body. A file, so the body never rides an argv. */
  bodyFile: string;
  draft: boolean;
  cwd: string;
}

/** Open the pull request. Returns its URL. */
export function prCreate(request: PrRequest): string {
  const args = [
    "pr",
    "create",
    "--base",
    request.base,
    "--head",
    request.head,
    "--title",
    request.title,
    "--body-file",
    request.bodyFile,
  ];
  if (request.draft) args.push("--draft");
  const out = gh(args, request.cwd);
  // gh prints the URL on the last line; earlier lines are progress chatter.
  const url = out.split("\n").filter(Boolean).pop() ?? "";
  if (!url.startsWith("http")) {
    throw new GhError(`gh pr create returned no URL:\n${out}`);
  }
  return url;
}
