/**
 * Session lifecycle: parse the CLI, validate, take the lock, build the Run.
 *
 * `adw()` is the one entry point every ADW script uses, so the order of
 * operations is written down once instead of five times:
 *
 *   load config -> validate REQUIRED_AGENTS -> resolve target -> dirty guard
 *   -> take the path lock -> open the session -> run the body -> finish
 *
 * Everything before "open the session" is cheap and can refuse the run on the
 * terminal in a second. Nothing spawns until all of it has passed (hard rule 1).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG_PATH, loadConfig, validate } from "./config.ts";
import { Run } from "./runner.ts";
import { acquireLock, assertClean, resolveTarget } from "./targets.ts";
import { Tracer } from "./tracer.ts";
import type { ResolvedTarget, SfoConfig } from "./types.ts";
import { engineerName, expandHome, newId, resolvePrompt } from "./utils.ts";

/** The factory root, derived from this file's own location. */
export function factoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function promptRoot(): string {
  return path.join(factoryRoot(), "adws", "adw_data", "prompt_engineering");
}

export function configPath(override?: string): string {
  return override ? expandHome(override) : path.join(factoryRoot(), DEFAULT_CONFIG_PATH);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  prompt: string;
  /** The PRIMARY target: the first `--target`. Every single-target ADW reads this. */
  target: string;
  /** Every `--target`, in the order given. Order is meaning: see adw_trace.ts. */
  targets: string[];
  adwId?: string;
  config?: string;
  agent?: string;
  base?: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/**
 * A deliberately small parser. Every ADW takes the same shape:
 *
 *     npm run <adw> -- --target NAME [--adw-id ID] [--agent NAME] "<prompt>"
 *
 * The prompt is the one positional; a path resolves to that file's contents.
 *
 * `--target` is the one flag that may REPEAT. Everything else overwrites, which
 * is what a flag normally means; a second target is a second repo in the same
 * run rather than a correction of the first, so those accumulate in order.
 */
export function parseArgs(argv: string[], opts: { requirePrompt?: boolean } = {}): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const targets: string[] = [];
  // `--target` accumulates; every other flag keeps last-wins. The flags map
  // still holds the FIRST target, so `flags["target"]` reads as it always did.
  const take = (name: string, value: string): void => {
    if (name === "target") {
      targets.push(value);
      if (typeof flags["target"] !== "string") flags["target"] = value;
      return;
    }
    flags[name] = value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    const name = key!;
    if (inline !== undefined) {
      take(name, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      take(name, next);
      i += 1;
    } else {
      flags[name] = true;
    }
  }

  const target = typeof flags["target"] === "string" ? flags["target"] : "";
  if (!target) {
    throw new Error(
      "--target is required. The factory drives many repos from one install, so " +
        "every run has to say which one. Try: npm run doctor",
    );
  }
  const prompt = positionals.length ? resolvePrompt(positionals.join(" ")) : "";
  if (opts.requirePrompt !== false && !prompt) {
    throw new Error("a prompt is required — pass it as the last argument, inline or as a file path");
  }

  const parsed: ParsedArgs = { prompt, target, targets, flags, positionals };
  if (typeof flags["adw-id"] === "string") parsed.adwId = flags["adw-id"];
  if (typeof flags["config"] === "string") parsed.config = flags["config"];
  if (typeof flags["agent"] === "string") parsed.agent = flags["agent"];
  if (typeof flags["base"] === "string") parsed.base = flags["base"];
  return parsed;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * A killed run still closes its own trace.
 *
 * Without this, `kill <pid>` leaves the session reading `running` forever and
 * its process rows open — the trace would claim work is in flight that is
 * already dead.
 */
function finalizeWhenKilled(run: Run, release: () => void): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      run.tracer.sessionFinish(run.adw_id, false); // also closes process rows
      release();
      process.exit(128 + (signal === "SIGINT" ? 2 : 15));
    });
  }
}

export interface AdwOptions {
  /** ADW script name, recorded on the session so a chained run reads sensibly. */
  name: string;
  /** Hard rule 1: declared up front, validated before anything spawns. */
  requiredAgents: string[];
  argv: string[];
  requirePrompt?: boolean;
  /** A read-only ADW skips the dirty guard; anything that writes must not. */
  requireCleanRepo?: boolean;
  body: (run: Run, args: ParsedArgs) => Promise<number>;
}

/**
 * Run one ADW end to end and return its exit code.
 *
 * Errors are caught here rather than escaping to a stack trace: an operator
 * needs the sentence, and the trace needs the phase it died in.
 */
export async function adw(options: AdwOptions): Promise<number> {
  let args: ParsedArgs;
  let cfg: SfoConfig;
  try {
    const bootArgs = parseArgs(options.argv, { requirePrompt: options.requirePrompt ?? true });
    args = bootArgs;
    cfg = loadConfig(configPath(args.config));
    validate(cfg, options.requiredAgents, {
      promptRoot: promptRoot(),
      cwd: factoryRoot(),
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  let targets: ResolvedTarget[];
  try {
    targets = args.targets.map((name) => resolveTarget(cfg, name));
    if (options.requireCleanRepo !== false) for (const t of targets) assertClean(t);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const adwId = args.adwId ?? newId(8);

  // One lock per distinct PATH, not per target. `api` and `front` are two rows
  // over one oms checkout, so naming both would otherwise deadlock the run
  // against itself on the second acquire.
  const locks: (Disposable & { path: string })[] = [];
  const releaseLocks = () => {
    for (const held of locks.splice(0)) held[Symbol.dispose]();
  };
  try {
    const locked = new Set<string>();
    for (const t of targets) {
      if (locked.has(t.path)) continue;
      locked.add(t.path);
      locks.push(acquireLock(cfg, t, adwId));
    }
  } catch (error) {
    releaseLocks(); // a later target's refusal must not strand an earlier lock
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const dataDir = expandHome(cfg.defaults.data_dir);
  const tracer = new Tracer(
    expandHome(cfg.observability.db),
    path.join(dataDir, "sessions", adwId, "events.jsonl"),
  );
  const run = new Run({
    cfg,
    adwId,
    tracer,
    engineer: engineerName(),
    targets,
    promptRoot: promptRoot(),
  });

  tracer.sessionStart({
    adwId,
    engineer: run.engineer,
    adwName: options.name,
    // Every target the run drove, in order — a one-target run is unchanged, and
    // a cross-repo run is visible as such in the session list and its filter.
    target: targets.map((t) => t.name).join("+"),
    repoPath: [...new Set(targets.map((t) => t.path))].join(" "),
  });
  // This process IS the run. Record it before any phase opens, so a run that
  // hangs in its first agent call is still killable by adw_id.
  tracer.processStart(adwId, "adw", "", process.pid, [options.name, ...options.argv].join(" "));
  finalizeWhenKilled(run, releaseLocks);
  run.console.sessionStarted(
    adwId,
    run.engineer,
    targets.map((t) => t.name).join(" + "),
    [...new Set(targets.map((t) => t.path))].join("\n        "),
  );

  try {
    return await options.body(run, args);
  } catch (error) {
    run.recordFailure(error);
    process.stderr.write(`\n${(error as Error).message ?? String(error)}\n`);
    return run.finish(false, (error as Error).message ?? String(error));
  } finally {
    releaseLocks();
    tracer.close();
  }
}

/** Boilerplate every ADW script ends with. */
export function main(code: Promise<number>): void {
  code.then(
    (exit) => process.exit(exit),
    (error) => {
      process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
      process.exit(1);
    },
  );
}
