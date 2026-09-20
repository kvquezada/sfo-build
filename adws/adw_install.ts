#!/usr/bin/env bun
/**
 * Register a repo as a TARGET. This is what "install" means here.
 *
 *   npm run install-target -- --path ~/Workspace/personal/oms --name oms \
 *       [--subdir apps/api] [--test "npx nx run-many -t test"] [--lint "..."]
 *
 * SSSF installed itself INTO a repo: it copied `adws/`, a config and a prompt
 * set into the codebase, so every repo carried its own divergent factory. This
 * one is central (decision 1). Nothing is copied into the target; a row is
 * appended to the registry, and `--target NAME` selects it from then on.
 *
 * That difference is the whole point of decision 9 — one roster, one prompt
 * set, all targets. Per-repo factory variants are a known impossibility, not
 * an oversight.
 *
 * The commands are DETECTED and then VERIFIED by running them. A registry
 * entry that was guessed is the placeholder problem wearing a different hat:
 * `quality.ts` refuses to invent a command, so this refuses to record one it
 * has not seen exit 0.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "./adw_modules/config.ts";
import { configPath, parseArgs } from "./adw_modules/session.ts";
import { absolute, operatorEnv, shellJoin } from "./adw_modules/utils.ts";

const OK = "  \x1b[32m✓\x1b[0m";
const BAD = "  \x1b[31m✗\x1b[0m";
const WARN = "  \x1b[33m!\x1b[0m";

interface Detected {
  test: string[];
  lint: string[];
  why: string;
}

/**
 * Guess the repo's commands from what is actually on disk.
 *
 * Only ever a starting point: whatever comes back is run before it is written
 * down, and a command that does not pass is offered rather than recorded.
 */
function detect(repo: string): Detected {
  const pkgPath = path.join(repo, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const runner = existsSync(path.join(repo, "bun.lock")) || existsSync(path.join(repo, "bun.lockb"))
      ? "bun"
      : "npm";

    if (existsSync(path.join(repo, "nx.json")) || deps["nx"]) {
      return {
        test: ["npx", "nx", "run-many", "-t", "test"],
        lint: ["npx", "nx", "run-many", "-t", "lint"],
        why: "nx.json present — running every project's target",
      };
    }
    const scripts = pkg.scripts ?? {};
    const call = (script: string) => (runner === "bun" ? ["bun", "run", script] : ["npm", "run", script]);
    return {
      test: scripts["test"] ? call("test") : [],
      lint: scripts["lint"] ? call("lint") : [],
      why: `package.json scripts, via ${runner}`,
    };
  }
  if (existsSync(path.join(repo, "pyproject.toml"))) {
    return { test: ["pytest", "-q"], lint: [], why: "pyproject.toml present" };
  }
  if (existsSync(path.join(repo, "Cargo.toml"))) {
    return { test: ["cargo", "test"], lint: ["cargo", "clippy"], why: "Cargo.toml present" };
  }
  return { test: [], lint: [], why: "no recognised project manifest" };
}

/** Run a candidate command for real. A registry entry is earned, not guessed. */
function verify(argv: string[], cwd: string): { ok: boolean; detail: string } {
  const started = performance.now();
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    env: operatorEnv(),
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (result.error) return { ok: false, detail: result.error.message };
  return {
    ok: result.status === 0,
    detail: `exit ${result.status} in ${seconds}s`,
  };
}

function yamlList(argv: string[]): string {
  return `[${argv.map((a) => (/[\s:#]/.test(a) ? JSON.stringify(a) : a)).join(", ")}]`;
}

/**
 * The branch a ship run should target, read from the remote rather than guessed.
 *
 * `master` is the schema default, and a wrong default only surfaces when
 * someone ships. Asking the remote what its HEAD is costs one command here and
 * saves that.
 */
function detectBaseBranch(repo: string, remote: string): string {
  const read = (args: string[]): string => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: operatorEnv(),
      timeout: 15_000,
    });
    return result.status === 0 ? (result.stdout ?? "").trim() : "";
  };
  // The local note of where origin/HEAD points, set at clone time.
  const symbolic = read(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  if (symbolic.startsWith(`${remote}/`)) return symbolic.slice(remote.length + 1);
  // No note (a repo cloned shallow, or one whose HEAD was never set): ask.
  const queried = read(["ls-remote", "--symref", remote, "HEAD"]);
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(queried);
  if (match) return match[1]!;
  return read(["rev-parse", "--abbrev-ref", "HEAD"]) || "master";
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(["--target", "_unused", ...argv], { requirePrompt: false });
  const flags = args.flags;

  const rawPath = typeof flags["path"] === "string" ? flags["path"] : "";
  if (!rawPath) {
    process.stderr.write(
      "usage: npm run install-target -- --path <repo> [--name N] [--subdir D] " +
        '[--test "cmd"] [--lint "cmd"] [--base-branch B] [--remote R] [--force]\n',
    );
    return 2;
  }
  const repo = absolute(rawPath);
  const subdir = typeof flags["subdir"] === "string" ? flags["subdir"] : "";
  const name = typeof flags["name"] === "string" ? flags["name"] : path.basename(repo);
  const scope = subdir ? path.join(repo, subdir) : repo;

  process.stdout.write(`\n\x1b[1mregistering '${name}'\x1b[0m\n`);

  if (!existsSync(repo)) {
    process.stdout.write(`${BAD} ${repo} does not exist\n`);
    return 1;
  }
  const isRepo = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8" }).status === 0;
  if (!isRepo) {
    process.stdout.write(
      `${BAD} ${repo} is not a git repository.\n` +
        `      Every run works in place and is measured against git — the dirty guard,\n` +
        `      the permission backstop and the diff capture all need one.\n`,
    );
    return 1;
  }
  process.stdout.write(`${OK} git repository   ${repo}\n`);
  if (subdir) {
    if (!existsSync(scope)) {
      process.stdout.write(`${BAD} subdir ${subdir} does not exist under ${repo}\n`);
      return 1;
    }
    process.stdout.write(`${OK} scope            ${subdir}  (bounds WRITES; reads stay repo-wide)\n`);
  }

  const cfgPath = configPath(typeof args.config === "string" ? args.config : undefined);
  const cfg = loadConfig(cfgPath);
  const existing = cfg.targets.find((t) => t.name === name);
  if (existing && flags["force"] !== true) {
    process.stdout.write(
      `${BAD} target '${name}' is already registered (${existing.path}).\n` +
        `      Pick another --name, or pass --force to print a replacement row.\n`,
    );
    return 1;
  }

  const guess = detect(repo);
  const parse = (flag: string, fallback: string[]): string[] => {
    const raw = flags[flag];
    return typeof raw === "string" && raw.trim() ? raw.trim().split(/\s+/) : fallback;
  };
  const testArgv = parse("test", guess.test);
  const lintArgv = parse("lint", guess.lint);
  process.stdout.write(`${OK} detected         ${guess.why}\n`);

  let problems = 0;
  const verified: Record<string, string[]> = {};
  for (const [label, candidate] of [
    ["test", testArgv],
    ["lint", lintArgv],
  ] as const) {
    if (!candidate.length) {
      process.stdout.write(
        `${WARN} ${label.padEnd(16)} none detected — pass --${label} "<command>" to set one\n`,
      );
      if (label === "test") problems += 1;
      continue;
    }
    process.stdout.write(`  running ${label}: ${shellJoin(candidate)}  (in ${scope})\n`);
    const result = verify(candidate, scope);
    if (result.ok) {
      process.stdout.write(`${OK} ${label.padEnd(16)} ${result.detail}\n`);
      verified[label] = candidate;
    } else {
      process.stdout.write(
        `${BAD} ${label.padEnd(16)} ${result.detail} — NOT recorded.\n` +
          `      A command that has not passed here is a placeholder, and a placeholder\n` +
          `      that exits 0 is believed by every phase downstream. Fix it, or pass a\n` +
          `      different --${label}, then re-run.\n`,
      );
      if (label === "test") problems += 1;
    }
  }

  const remote = typeof flags["remote"] === "string" ? flags["remote"] : "origin";
  const baseBranch =
    typeof flags["base-branch"] === "string"
      ? flags["base-branch"]
      : detectBaseBranch(repo, remote);
  process.stdout.write(
    `${OK} ${"base branch".padEnd(16)} ${baseBranch} (ship cuts branches from ${remote}/${baseBranch})\n`,
  );

  const row =
    `  - name: ${name}\n` +
    `    path: ${rawPath}\n` +
    (subdir ? `    subdir: ${subdir}\n` : "") +
    `    base_branch: ${baseBranch}\n` +
    (remote !== "origin" ? `    remote: ${remote}\n` : "") +
    (verified["test"] ? `    test: ${yamlList(verified["test"])}\n` : "") +
    (verified["lint"] ? `    lint: ${yamlList(verified["lint"])}\n` : "");

  if (problems) {
    process.stdout.write(
      `\n\x1b[1m${problems} problem(s) — nothing was written\x1b[0m\n` +
        `A target with no verified test command cannot be driven: every chain that\n` +
        `commits does so only after a green suite.\n`,
    );
    return 1;
  }

  if (flags["write"] === true) {
    const text = readFileSync(cfgPath, "utf8");
    writeFileSync(cfgPath, `${text.replace(/\s*$/, "")}\n\n${row}`);
    process.stdout.write(`\n${OK} appended to ${cfgPath}\n`);
  } else {
    process.stdout.write(
      `\n\x1b[1madd this to the targets: list in\x1b[0m ${cfgPath}\n\n${row}\n` +
        `  (or re-run with --write to append it automatically)\n`,
    );
  }
  process.stdout.write(
    `\nThen:  npm run doctor -- --target ${name}\n` +
      `       npm run scout  -- --target ${name} "where does X live"\n\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  },
);
