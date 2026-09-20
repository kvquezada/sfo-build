/**
 * Load the roster, merge defaults into it, and validate before anything spawns.
 *
 * Hard rule 1: every ADW declares REQUIRED_AGENTS and validates first. A
 * half-valid config must fail on the terminal in a second, not three phases
 * and two premium requests into a run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

import { SfoConfig, type AgentConfig, type CodingAgent } from "./types.ts";
import { resolveTools, unsupported, UnknownToolError } from "./tool_map.ts";
import { absolute, expandHome, formatZodError, operatorEnv } from "./utils.ts";

export const DEFAULT_CONFIG_PATH = "adws/adw_sfo_config/sfo.config.yaml";

export class ConfigError extends Error {}

/** Keys an agent inherits from `defaults:` when it does not set them itself. */
const INHERITED = [
  "coding_agent",
  "model",
  "thinking",
  "color",
  "tools",
  "tools_extra",
] as const;

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): SfoConfig {
  const file = absolute(configPath);
  if (!existsSync(file)) {
    throw new ConfigError(`config not found: ${file}`);
  }
  const raw = (parseYaml(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
  const defaults = (raw["defaults"] ?? {}) as Record<string, unknown>;

  // Merge before parsing, so a roster entry that omits `model` inherits the
  // default rather than falling through to the schema's own placeholder.
  for (const agent of (raw["agents"] ?? []) as Record<string, unknown>[]) {
    for (const key of INHERITED) {
      if (key in defaults && !(key in agent)) agent[key] = defaults[key];
    }
  }

  const parsed = SfoConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid config ${file}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

export function resolveAgent(cfg: SfoConfig, name: string): AgentConfig {
  const agent = cfg.agents.find((a) => a.name === name);
  if (!agent) {
    throw new ConfigError(
      `agent '${name}' is not defined in the config — available: ` +
        `${cfg.agents.map((a) => a.name).join(", ") || "(none)"}`,
    );
  }
  return agent;
}

// ── model probing ────────────────────────────────────────────────────────────
//
// Known impossibility 2: there is no `--list-models` and no local catalog, so a
// bad id cannot be caught by reading anything. What CAN be done is measured: an
// unavailable model exits 1 in ~5s with `Model "X" ... is not available.` on
// stderr, BEFORE any model call — so probing costs time, not a premium request.
// The verdict is cached; `doctor` is how you refresh it.

interface ProbeCache {
  version: number;
  probed: Record<string, { available: boolean; at: string; detail: string; tools?: string[] }>;
}

// Bumped when the probe started capturing each model's tool dialect.
const PROBE_VERSION = 2;
const PROBE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // a fortnight — the roster is stable

function probePath(cfg: SfoConfig): string {
  return path.join(expandHome(cfg.defaults.data_dir), "model_probe.json");
}

function readProbeCache(cfg: SfoConfig): ProbeCache {
  const file = probePath(cfg);
  if (!existsSync(file)) return { version: PROBE_VERSION, probed: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ProbeCache;
    if (parsed.version !== PROBE_VERSION) return { version: PROBE_VERSION, probed: {} };
    return parsed;
  } catch {
    return { version: PROBE_VERSION, probed: {} };
  }
}

function writeProbeCache(cfg: SfoConfig, cache: ProbeCache): void {
  const file = probePath(cfg);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2));
}

export interface ModelVerdict {
  model: string;
  available: boolean;
  detail: string;
  cached: boolean;
  /** The tool names THIS model actually offers. Dialects differ; see tool_map.ts. */
  tools: string[];
}

/**
 * Ask Copilot whether it will accept this model id.
 *
 * Deliberately synchronous and deliberately cheap: it sends a one-word prompt
 * with every tool excluded, so an AVAILABLE model answers in a couple of
 * seconds and an unavailable one never reaches the API at all.
 */
function probeCopilotModel(
  model: string,
  cwd: string,
): { available: boolean; detail: string; tools: string[] } {
  const result = spawnSync(
    "copilot",
    [
      "-p",
      "Reply with the single word: ok",
      "--model",
      model,
      "--stream",
      "off",
      "--output-format",
      "json",
      "--allow-all-tools",
      "--reasoning-effort",
      "none",
      // bash excluded so a probe can never RUN anything; every other tool is
      // left listed, because the point is to read this model's dialect out of
      // session.usage_checkpoint. The prompt itself calls nothing.
      "--excluded-tools",
      "bash",
      "-C",
      cwd,
    ],
    { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], env: operatorEnv() },
  );
  const stderr = (result.stderr ?? "").trim();
  if (/is not available/i.test(stderr)) {
    return { available: false, detail: stderr.split("\n")[0] ?? stderr, tools: [] };
  }
  if (result.status !== 0) {
    return {
      available: false,
      detail: stderr.split("\n")[0] || `copilot exited ${result.status}`,
      tools: [],
    };
  }
  return { available: true, detail: "probe accepted the model", tools: offeredTools(result.stdout ?? "", model) };
}

/** Read `tools[].name` for this model out of a probe's usage_checkpoint. */
function offeredTools(stdout: string, model: string): string[] {
  for (const line of stdout.split("\n")) {
    if (!line.includes("usage_checkpoint")) continue;
    try {
      const event = JSON.parse(line) as {
        data?: { promptCacheBreakState?: { models?: Record<string, { tools?: { name?: string }[] }> }[] };
      };
      const models = event.data?.promptCacheBreakState?.[0]?.models ?? {};
      const stats = models[model] ?? Object.values(models)[0];
      if (stats?.tools) {
        return stats.tools.map((t) => String(t.name ?? "")).filter(Boolean).sort();
      }
    } catch {
      continue;
    }
  }
  return [];
}

export function probeModel(
  cfg: SfoConfig,
  model: string,
  opts: { refresh?: boolean; cwd?: string } = {},
): ModelVerdict {
  const cache = readProbeCache(cfg);
  const hit = cache.probed[model];
  const fresh = hit && Date.now() - Date.parse(hit.at) < PROBE_TTL_MS;
  if (hit && fresh && !opts.refresh) {
    return { model, available: hit.available, detail: hit.detail, tools: hit.tools ?? [], cached: true };
  }
  const verdict = probeCopilotModel(model, opts.cwd ?? process.cwd());
  cache.probed[model] = { ...verdict, at: new Date().toISOString() };
  writeProbeCache(cfg, cache);
  return { model, ...verdict, cached: false };
}

/** Every distinct model the roster names — what `doctor` walks. */
export function rosterModels(cfg: SfoConfig): string[] {
  return [...new Set(cfg.agents.map((a) => a.model))].sort();
}

// ── validation ───────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /** Resolve each agent's prompt pair under this directory. */
  promptRoot: string;
  /** Probe models against the cache. Off for unit-ish runs, on by default. */
  checkModels?: boolean;
  cwd?: string;
}

export function promptPaths(
  promptRoot: string,
  agent: string,
): { system: string; user: string } {
  return {
    system: path.join(promptRoot, agent, "system.md"),
    user: path.join(promptRoot, agent, "user.md"),
  };
}

/**
 * Fail fast: every required name must resolve to a usable agent.
 *
 * Collects EVERY problem before throwing. A config with three typos should
 * take one run to fix, not three.
 */
export function validate(
  cfg: SfoConfig,
  required: string[],
  opts: ValidateOptions,
): void {
  const problems: string[] = [];

  for (const name of required) {
    let agent: AgentConfig;
    try {
      agent = resolveAgent(cfg, name);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }

    if (agent.coding_agent !== "copilot") {
      problems.push(
        `agent '${name}': coding_agent '${agent.coding_agent}' is not implemented ` +
          `in v1 — the factory runs GitHub Copilot only (decision 4).`,
      );
    }

    const { system, user } = promptPaths(opts.promptRoot, name);
    for (const [label, ref] of [
      ["system", system],
      ["user", user],
    ] as const) {
      if (!existsSync(ref)) problems.push(`agent '${name}': ${label} prompt not found: ${ref}`);
    }

    // An unmapped tool name is a hard fail here, never a silent drop.
    try {
      resolveTools(agent.coding_agent as CodingAgent, agent.tools, agent.tools_extra);
      const missing = unsupported(agent.coding_agent as CodingAgent, agent.tools);
      if (missing.length) {
        problems.push(
          `agent '${name}': ${missing.join(", ")} has no equivalent on ` +
            `${agent.coding_agent} — drop it or move it to tools_extra.`,
        );
      }
    } catch (error) {
      if (error instanceof UnknownToolError) problems.push(`agent '${name}': ${error.message}`);
      else throw error;
    }
  }

  if (opts.checkModels !== false) {
    const models = [
      ...new Set(
        required
          .map((n) => cfg.agents.find((a) => a.name === n)?.model)
          .filter((m): m is string => Boolean(m)),
      ),
    ];
    for (const model of models) {
      const verdict = probeModel(cfg, model, { cwd: opts.cwd });
      if (!verdict.available) {
        const who = required.filter((n) => cfg.agents.find((a) => a.name === n)?.model === model);
        problems.push(
          `model '${model}' (used by ${who.join(", ")}) is not available: ${verdict.detail}` +
            (verdict.cached ? " [cached — run `npm run doctor` to re-probe]" : ""),
        );
      }
    }
  }

  if (problems.length) {
    throw new ConfigError(`config validation failed:\n- ${problems.join("\n- ")}`);
  }
}
