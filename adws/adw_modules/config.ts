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

import { SfoConfig, TargetConfig, type AgentConfig, type CodingAgent } from "./types.ts";
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

  // Targets are per machine. Refusing them here, rather than merging, is what
  // stops a teammate's registration from landing in a shared commit.
  const dataDir = typeof defaults["data_dir"] === "string" ? defaults["data_dir"] : "~/.sfo-build";
  const targetsFile = targetsPath(dataDir);
  if ("targets" in raw) {
    throw new ConfigError(
      `${file} has a targets: key, but targets are per machine. Move those rows ` +
        `into ${targetsFile} (same shape: a top-level targets: list) and delete ` +
        `them from the shared config.`,
    );
  }
  raw["targets"] = readTargets(targetsFile);

  const parsed = SfoConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid config ${file}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

/** This machine's target registry: `$SFO_TARGETS`, else `<data_dir>/targets.yaml`. */
export function targetsPath(dataDir: string): string {
  const override = process.env["SFO_TARGETS"];
  return override ? absolute(override) : path.join(absolute(dataDir), "targets.yaml");
}

/** No file is a fresh machine, not an error: it has no targets yet. */
function readTargets(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const raw = (parseYaml(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
  const parsed = TargetConfig.array().safeParse(raw["targets"] ?? []);
  if (!parsed.success) {
    throw new ConfigError(`invalid targets ${file}: ${formatZodError(parsed.error)}`);
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

// v2 captured each model's tool dialect; v3 keys on (model, thinking) because
// reasoning-effort support is per-model too — see probeModel.
const PROBE_VERSION = 3;
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
  thinking: string;
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
  thinking: string,
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
      thinking,
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

/**
 * Probe a (model, thinking) PAIR, not a model.
 *
 * Reasoning-effort support is per-model and there is no catalog to read it
 * from either. Measured: `claude-haiku-4.5` accepts `none` and rejects every
 * other level with `does not support reasoning effort configuration`, while
 * `claude-sonnet-5` takes the full range. Probing only the model — which this
 * did at first, always with `none` — passes every roster and then fails at the
 * documenter's phase, eight phases into a run that has already committed twice.
 */
export function probeModel(
  cfg: SfoConfig,
  model: string,
  thinking: string,
  opts: { refresh?: boolean; cwd?: string } = {},
): ModelVerdict {
  const cache = readProbeCache(cfg);
  const key = `${model}::${thinking}`;
  const hit = cache.probed[key];
  const fresh = hit && Date.now() - Date.parse(hit.at) < PROBE_TTL_MS;
  if (hit && fresh && !opts.refresh) {
    return {
      model,
      thinking,
      available: hit.available,
      detail: hit.detail,
      tools: hit.tools ?? [],
      cached: true,
    };
  }
  const verdict = probeCopilotModel(model, thinking, opts.cwd ?? process.cwd());
  cache.probed[key] = { ...verdict, at: new Date().toISOString() };
  writeProbeCache(cfg, cache);
  return { model, thinking, ...verdict, cached: false };
}

/** Every distinct (model, thinking) pair the roster names — what `doctor` walks. */
export function rosterModels(cfg: SfoConfig): { model: string; thinking: string }[] {
  const seen = new Map<string, { model: string; thinking: string }>();
  for (const agent of cfg.agents) {
    seen.set(`${agent.model}::${agent.thinking}`, { model: agent.model, thinking: agent.thinking });
  }
  return [...seen.values()].sort((a, b) => a.model.localeCompare(b.model));
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
    const pairs = new Map<string, { model: string; thinking: string; who: string[] }>();
    for (const name of required) {
      const agent = cfg.agents.find((a) => a.name === name);
      if (!agent) continue;
      const key = `${agent.model}::${agent.thinking}`;
      const entry = pairs.get(key) ?? { model: agent.model, thinking: agent.thinking, who: [] };
      entry.who.push(name);
      pairs.set(key, entry);
    }
    for (const { model, thinking, who } of pairs.values()) {
      const verdict = probeModel(cfg, model, thinking, { cwd: opts.cwd });
      if (!verdict.available) {
        problems.push(
          `model '${model}' at thinking '${thinking}' (used by ${who.join(", ")}) ` +
            `is not usable: ${verdict.detail}` +
            (verdict.cached ? " [cached — run `npm run doctor --refresh` to re-probe]" : ""),
        );
      }
    }
  }

  if (problems.length) {
    throw new ConfigError(`config validation failed:\n- ${problems.join("\n- ")}`);
  }
}
