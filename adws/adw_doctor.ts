#!/usr/bin/env bun
/**
 * Preflight: check everything a run depends on, without spawning one.
 *
 *   npm run doctor [-- --refresh] [--target oms]
 *
 * Known impossibility 2 is why this exists. Copilot ships no `--list-models`
 * and no local catalog, so a bad model id cannot be caught by reading anything
 * — it fails at run time. A cached probe is the best available substitute, and
 * this is where the cache is filled and refreshed.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { loadConfig, probeModel, promptPaths, rosterModels } from "./adw_modules/config.ts";
import * as permissions from "./adw_modules/permissions.ts";
import { configPath, factoryRoot, parseArgs, promptRoot } from "./adw_modules/session.ts";
import { resolveTarget } from "./adw_modules/targets.ts";
import { resolveTools } from "./adw_modules/tool_map.ts";
import { expandHome } from "./adw_modules/utils.ts";

const OK = "  \x1b[32m✓\x1b[0m";
const BAD = "  \x1b[31m✗\x1b[0m";
const WARN = "  \x1b[33m!\x1b[0m";

function heading(text: string): void {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const refresh = argv.includes("--refresh");
  let problems = 0;
  const fail = (line: string) => {
    problems += 1;
    process.stdout.write(`${BAD} ${line}\n`);
  };

  const args = (() => {
    try {
      return parseArgs(argv, { requirePrompt: false });
    } catch {
      return null; // --target is optional for the doctor
    }
  })();

  heading("factory");
  process.stdout.write(`${OK} factory root  ${factoryRoot()}\n`);
  const cfgPath = configPath(typeof args?.config === "string" ? args.config : undefined);
  if (!existsSync(cfgPath)) {
    fail(`config missing: ${cfgPath}`);
    return problems;
  }
  const cfg = loadConfig(cfgPath);
  process.stdout.write(`${OK} config        ${cfgPath}\n`);

  heading("runtime");
  const dataDir = expandHome(cfg.defaults.data_dir);
  try {
    // The one invariant the whole permission model rests on. --add-dir grants
    // a TREE, and the session dir must be granted, so a runtime inside the
    // factory would hand every agent the engine that grades it.
    permissions.assertRuntimeOutsideFactory(dataDir);
    process.stdout.write(`${OK} data_dir      ${dataDir} (outside the factory tree)\n`);
  } catch (error) {
    fail((error as Error).message);
  }
  process.stdout.write(`${OK} db            ${expandHome(cfg.observability.db)}\n`);
  if (permissions.factoryClean()) {
    process.stdout.write(`${OK} tripwire      armed — factory tree is clean\n`);
  } else {
    process.stdout.write(
      `${WARN} tripwire      the factory tree has uncommitted changes. That is fine\n` +
        `                while you are editing it, but the per-phase tripwire compares\n` +
        `                against the state at phase start, so only NEW changes trip it.\n`,
    );
  }

  heading("agents");
  for (const agent of cfg.agents) {
    const { system, user } = promptPaths(promptRoot(), agent.name);
    const havePrompts = existsSync(system) && existsSync(user);
    let toolText = "all tools";
    try {
      const resolved = resolveTools(agent.coding_agent, agent.tools, agent.tools_extra);
      toolText = resolved === null ? "all tools" : `${resolved.length} tools`;
    } catch (error) {
      toolText = `\x1b[31m${(error as Error).message}\x1b[0m`;
      problems += 1;
    }
    const writes =
      agent.writes === null
        ? "unrestricted"
        : agent.writes.length === 0
          ? "read-only"
          : `${agent.writes.length} path rule(s)`;
    process.stdout.write(
      `${havePrompts ? OK : BAD} ${agent.name.padEnd(11)} ${agent.model.padEnd(18)} ` +
        `${agent.thinking.padEnd(7)} ${toolText.padEnd(12)} ${writes}\n`,
    );
    if (!havePrompts) {
      problems += 1;
      if (!existsSync(system)) process.stdout.write(`      missing ${system}\n`);
      if (!existsSync(user)) process.stdout.write(`      missing ${user}\n`);
    }
  }

  heading("models  (no catalog exists — this is a live probe, cached 14d)");
  for (const model of rosterModels(cfg)) {
    const verdict = probeModel(cfg, model, { refresh, cwd: factoryRoot() });
    const who = cfg.agents.filter((a) => a.model === model).map((a) => a.name).join(", ");
    const tag = verdict.cached ? "cached" : "probed";
    if (verdict.available) {
      process.stdout.write(`${OK} ${model.padEnd(20)} ${tag.padEnd(7)} ${who}\n`);
    } else {
      fail(`${model.padEnd(20)} ${tag.padEnd(7)} ${who} — ${verdict.detail}`);
    }
  }

  heading("targets");
  for (const row of cfg.targets) {
    try {
      const target = resolveTarget(cfg, row.name);
      const scope = target.subdir || "(whole repo)";
      process.stdout.write(`${OK} ${target.name.padEnd(8)} ${target.path}  scope ${scope}\n`);
      for (const [label, argv2] of [
        ["test", target.test],
        ["lint", target.lint],
      ] as const) {
        if (!argv2.length) {
          process.stdout.write(`      ${WARN.trim()} no ${label} command configured\n`);
          continue;
        }
        process.stdout.write(`      ${label}: ${argv2.join(" ")}\n`);
      }
    } catch (error) {
      fail((error as Error).message);
    }
  }

  if (args?.target) {
    heading(`target '${args.target}' readiness`);
    try {
      const target = resolveTarget(cfg, args.target);
      const { assertClean } = await import("./adw_modules/targets.ts");
      assertClean(target);
      process.stdout.write(`${OK} working tree is clean — a run can start\n`);
    } catch (error) {
      fail((error as Error).message.split("\n")[0] ?? "not ready");
    }
  }

  heading(problems ? `${problems} problem(s)` : "ready");
  if (!problems) {
    process.stdout.write(
      `  Try:  npm run prompt -- --target ${cfg.targets[0]?.name ?? "oms"} "summarize this repo in one line"\n`,
    );
  }
  return problems ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  },
);
