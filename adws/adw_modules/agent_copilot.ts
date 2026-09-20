/**
 * GitHub Copilot CLI interface — v1's only coding agent.
 *
 * Runs `copilot -p --output-format json --stream off` and tails its JSONL
 * stdout line by line, forwarding each event to a callback WHILE the agent
 * works. `--session-id <uuid>` is create-or-continue (MEASURED, 2026-09-20:
 * a second send on the same id answered from the first turn's context with
 * message_count=3), so running and continuing an agent are the same call —
 * which is what makes a correction turn cheap instead of a cold restart.
 *
 * `--stream off` is REQUIRED. With streaming on, the transcript floods with
 * per-token assistant.message_delta events; off, a turn is ~13 events.
 *
 * ── What this adapter CANNOT do ──────────────────────────────────────────────
 * There is no `--system-prompt`, and there never will be. An external `--agent`
 * file arrives as the system segment `selected_agent_instructions` ALONGSIDE
 * Copilot's own `identity` segment — agent identity is APPEND-ONLY. Every agent
 * is "Copilot plus your instructions", never yours alone, so prompts must
 * over-specify to compensate. See identity.ts for how the file gets there.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { emptyUsage, type AgentRequest, type AgentResult, type UsageBreakdown } from "./types.ts";
import { clip, nowIso, operatorEnv } from "./utils.ts";

export const COPILOT_PATH = process.env["COPILOT_PATH"] ?? "copilot";

const RESULT_SNIPPET_CHARS = 20_000; // tool output rides along whole; clip guards pathological cases
const ARG_VALUE_CHARS = 20_000; // args too — the UI scrolls, it must not get cut-off data
const LABEL_CHARS = 80; // "bash: <command>" shown as the event name

/** The arg that identifies a call at a glance, in the order Copilot's tools use it. */
const PRIMARY_ARGS = ["command", "path", "pattern", "query", "url", "prompt", "description"];

export interface CopilotEvent {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  ephemeral?: boolean;
  data?: Record<string, unknown>;
  // `result` is flat rather than nested under data
  sessionId?: string;
  exitCode?: number;
  usage?: Record<string, unknown>;
}

/** One finished tool call, normalized. */
export interface ToolCallRecord {
  tool: string;
  tool_call_id: string;
  args: Record<string, unknown>;
  ok: boolean;
  label: string;
  result_snippet?: string;
  duration_ms?: number;
  started_at?: string;
  ended_at?: string;
  /** Copilot's own event id for the completion, so the span tree stays intact. */
  parent_id?: string;
  exit_code?: number;
}

function label(tool: string, args: Record<string, unknown>): string {
  let value = "";
  for (const key of PRIMARY_ARGS) {
    const candidate = args[key];
    if (typeof candidate === "string" && candidate.trim()) {
      value = candidate;
      break;
    }
  }
  if (!value) {
    const first = Object.values(args).find((v) => typeof v === "string" && v.trim());
    value = typeof first === "string" ? first : "";
  }
  value = value.split(/\s+/).filter(Boolean).join(" ");
  return value ? `${tool}: ${clip(value, LABEL_CHARS)}` : tool;
}

/**
 * Folds Copilot's tool stream into ONE normalized record per completed call.
 *
 * Copilot announces a call with `tool.execution_start`, may emit any number of
 * `tool.execution_partial_result` updates, and closes with
 * `tool.execution_complete` — only the last carries the result, so that is
 * where a record is emitted. One trace event per real tool call, the moment it
 * returns, instead of N shapeless ones.
 *
 * NOTE the dots. These are `tool.execution_*`, not pi's `tool_execution_*`;
 * the names were read off a real stream, not translated from the Python.
 */
export class ToolCallTracker {
  private readonly open = new Map<
    string,
    { tool: string; args: Record<string, unknown>; started_at: string; clock: number }
  >();

  observe(event: CopilotEvent): ToolCallRecord | null {
    const type = event.type ?? "";
    const data = (event.data ?? {}) as Record<string, unknown>;
    const callId = String(data["toolCallId"] ?? "");

    if (type === "tool.execution_start") {
      if (!callId) return null;
      const known = this.open.get(callId);
      this.open.set(callId, {
        tool: String(data["toolName"] ?? known?.tool ?? ""),
        args: (data["arguments"] ?? known?.args ?? {}) as Record<string, unknown>,
        started_at: known?.started_at ?? nowIso(), // wall clock, for the row
        clock: known?.clock ?? performance.now(), // monotonic, for duration
      });
      return null;
    }

    if (type !== "tool.execution_complete") return null;

    const opened = this.open.get(callId);
    this.open.delete(callId);
    const tool = String(data["toolName"] ?? opened?.tool ?? "tool");
    const args = (data["arguments"] ?? opened?.args ?? {}) as Record<string, unknown>;
    const clippedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      clippedArgs[key] = typeof value === "string" ? clip(value, ARG_VALUE_CHARS) : value;
    }

    const shell = data["shellExecution"] as { exitCode?: number } | undefined;
    const record: ToolCallRecord = {
      tool,
      tool_call_id: callId,
      args: clippedArgs,
      ok: data["success"] !== false,
      label: label(tool, args),
      ended_at: nowIso(),
      parent_id: event.id ?? "",
    };
    if (shell && typeof shell.exitCode === "number") record.exit_code = shell.exitCode;

    const result = data["result"] as { content?: unknown } | undefined;
    const content = result?.content;
    if (typeof content === "string" && content) {
      record.result_snippet = clip(content, RESULT_SNIPPET_CHARS);
    }
    if (opened) {
      record.started_at = opened.started_at;
      record.duration_ms = Math.round(performance.now() - opened.clock);
    }
    return record;
  }
}

/**
 * Usage gauges are CUMULATIVE WITHIN A SESSION, not per-call. Measured: one
 * turn reported totalPremiumRequests 14; the second turn on the same session
 * reported 28. So a call's real cost is the delta against what this session had
 * already spent — which the caller carries across processes in agent_map.json,
 * because a resumed session does not restart at zero.
 */
export interface UsageGauge {
  premium_requests: number;
  nano_aiu: number;
}

export interface CopilotCallbacks {
  onEvent?: (event: CopilotEvent) => void;
  onToolCall?: (record: ToolCallRecord) => void;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}

export interface CopilotRunResult extends AgentResult {
  /** The raw session-cumulative gauge, for the caller to persist as the next baseline. */
  cumulative: UsageGauge;
}

export function buildArgs(request: AgentRequest): string[] {
  const args = [
    "-p",
    request.prompt,
    "--model",
    request.model,
    "--reasoning-effort",
    request.thinking,
    "--session-id",
    request.sessionId,
    "--stream",
    "off",
    "--output-format",
    "json",
    // Required for non-interactive. Measured: it does NOT imply
    // --allow-all-paths, so the path sandbox stays in force — which is the
    // whole basis of decision 6's "prevent" half.
    "--allow-all-tools",
    "-C",
    request.cwd,
  ];
  for (const dir of request.addDirs) args.push("--add-dir", dir);
  // --agent selects the identity file that identity.ts wrote into the agent's
  // own --add-dir'd tree. Its name matches the roster entry.
  args.push("--agent", request.agentName);
  if (request.tools !== null) args.push("--available-tools", ...request.tools);
  return args;
}

/** Run one non-interactive Copilot turn. */
export async function run(
  request: AgentRequest,
  baseline: UsageGauge,
  callbacks: CopilotCallbacks = {},
): Promise<CopilotRunResult> {
  const args = buildArgs(request);
  mkdirSync(path.dirname(request.rawOutputPath), { recursive: true });

  const tracker = new ToolCallTracker();
  const usage: UsageBreakdown = emptyUsage();
  const cumulative: UsageGauge = { ...baseline };
  let text = "";
  let contextTokens = 0;
  let toolsOffered: string[] = [];
  let filesModified: string[] = [];
  let sessionId = request.sessionId;

  const child = spawn(COPILOT_PATH, args, {
    cwd: request.cwd,
    // stdin is DEVNULL deliberately. The prompt travels in argv, so the child
    // never needs stdin — but inheriting the parent's lets the CLI see a
    // non-TTY and sit forever waiting for piped input that never arrives.
    stdio: ["ignore", "pipe", "pipe"],
    env: operatorEnv({
      // Per-agent config/state dir, so one agent cannot read another's
      // sessions, memories or MCP state.
      COPILOT_HOME: request.homeDir,
    }),
  });
  if (child.pid && callbacks.onSpawn) callbacks.onSpawn(child.pid);

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    appendFileSync(request.rawOutputPath, `${line}\n`); // lands on disk as it happens
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: CopilotEvent;
    try {
      event = JSON.parse(trimmed) as CopilotEvent;
    } catch {
      continue; // a non-JSON line is not fatal; the raw file kept it either way
    }

    const data = (event.data ?? {}) as Record<string, unknown>;

    if (event.type === "assistant.message") {
      const content = data["content"];
      if (typeof content === "string" && content.trim()) text = content; // last wins
    } else if (event.type === "session.usage_checkpoint") {
      cumulative.nano_aiu = Number(data["totalNanoAiu"] ?? cumulative.nano_aiu);
      cumulative.premium_requests = Number(
        data["totalPremiumRequests"] ?? cumulative.premium_requests,
      );
      const breaks = data["promptCacheBreakState"] as
        | { models?: Record<string, Record<string, unknown>> }[]
        | undefined;
      const models = breaks?.[0]?.models ?? {};
      const stats = models[request.model] ?? Object.values(models)[0];
      if (stats) {
        // prompt_tokens is the size of the prompt actually sent this turn —
        // i.e. how full the window is right now. That is occupancy, and it is
        // the one honest context number Copilot exposes.
        contextTokens = Number(stats["prompt_tokens"] ?? 0);
        usage.prompt_tokens = contextTokens;
        usage.cache_read_tokens = Number(stats["cache_read"] ?? 0);
        usage.cache_write_tokens = Number(stats["cache_write"] ?? 0);
        const tools = stats["tools"] as { name?: string }[] | undefined;
        if (Array.isArray(tools)) {
          // What the model was ACTUALLY offered. Recorded on every call because
          // a restricted run once reported `rg` where an unrestricted run
          // reported `grep` — the map is never trusted over the stream.
          toolsOffered = tools.map((t) => String(t.name ?? "")).filter(Boolean);
        }
      }
    } else if (event.type === "result") {
      if (event.sessionId) sessionId = event.sessionId;
      const resultUsage = (event.usage ?? {}) as Record<string, unknown>;
      if (resultUsage["premiumRequests"] !== undefined) {
        cumulative.premium_requests = Number(resultUsage["premiumRequests"]);
      }
      const changes = resultUsage["codeChanges"] as { filesModified?: string[] } | undefined;
      if (Array.isArray(changes?.filesModified)) filesModified = changes.filesModified;
    }

    const toolRecord = tracker.observe(event);
    if (toolRecord && callbacks.onToolCall) callbacks.onToolCall(toolRecord);
    if (callbacks.onEvent) callbacks.onEvent(event);
  }

  const returncode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
  });
  if (child.pid && callbacks.onExit) callbacks.onExit(child.pid);

  // The gauges are session-cumulative, so this call's spend is the difference.
  // Math.max guards a resumed session whose baseline was written by a newer
  // run than the one being continued.
  usage.premium_requests = Math.max(0, cumulative.premium_requests - baseline.premium_requests);
  usage.nano_aiu = Math.max(0, cumulative.nano_aiu - baseline.nano_aiu);

  if (returncode !== 0 && !text) {
    throw new Error(
      `copilot exited ${returncode}: ${stderr.trim().slice(-800) || "(no stderr)"}`,
    );
  }

  return {
    text,
    returncode,
    sessionId,
    usage,
    cumulative,
    contextTokens,
    // Known impossibility 4: --context is a TIER, not a number, and there is no
    // catalog to read a ceiling from. Left 0 rather than guessed.
    contextWindow: 0,
    toolsOffered,
    filesModified,
  };
}
