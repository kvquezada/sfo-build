/**
 * One agent call: prompt in, typed envelope out, gates verified.
 *
 * Agent proposes, code disposes. Parse failures and gate violations re-prompt
 * the SAME Copilot session with a correction — context intact, bounded retries
 * — which is only affordable because `--session-id` is create-or-continue
 * (measured; see agent_copilot.ts). A correction costs one turn, not a cold
 * restart of the whole context window.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";

import * as copilot from "./agent_copilot.ts";
import * as permissions from "./permissions.ts";
import * as prompts from "./prompts.ts";
import { promptPaths, resolveAgent } from "./config.ts";
import { writeIdentity } from "./identity.ts";
import { missingFromOffer, resolveTools } from "./tool_map.ts";
import type { Run } from "./runner.ts";
import {
  emptyUsage,
  mergeUsage,
  type AgentCall,
  type AgentConfig,
  type EnvelopeBase,
  type EnvelopeSchema,
  type GateReport,
  type Phase,
  type ResolvedTarget,
  type UsageBreakdown,
} from "./types.ts";
import { agentSessionId, formatZodError, expandHome } from "./utils.ts";

/** Correction turns allowed for malformed JSON, before the phase dies. */
const JSON_FIX_ATTEMPTS = 2;

export class GateFailure extends Error {}

export interface AgentMapEntry {
  session_id: string;
  model: string;
  coding_agent: string;
  /** Last observed session-cumulative gauge, so a resumed session deltas correctly. */
  premium_requests: number;
  nano_aiu: number;
}

/**
 * The session id for this (run, agent) pair.
 *
 * UUIDv5 over (adw_id, agent): both CLIs demand a real UUID, so SSSF's
 * `sssf-{adw_id}-{agent}-{rand}` was simply invalid. Deriving it deterministically
 * keeps what that format was for — the same run + same agent rejoins the same
 * context window — without storing anything to look it up.
 *
 * A model change forces a NEW id: continuing one model's context window under
 * another model is not a resume, it is a transplant.
 */
function sessionIdFor(
  run: Run,
  agent: AgentConfig,
  key: string,
): { id: string; baseline: copilot.UsageGauge } {
  const entry = run.agentMap[key];
  if (entry && entry.model === agent.model) {
    return {
      id: entry.session_id,
      baseline: { premium_requests: entry.premium_requests, nano_aiu: entry.nano_aiu },
    };
  }
  const salt = entry ? `:${agent.model}` : "";
  return {
    id: agentSessionId(run.adw_id, `${key}${salt}`),
    baseline: { premium_requests: 0, nano_aiu: 0 },
  };
}

/**
 * The key one agent's state is filed under: `scout@api`.
 *
 * The TARGET belongs in the key, not just the agent name. Two scout phases over
 * two repos in one run are two different jobs — resuming the second into the
 * first's context window would carry repo A's file tree into a session whose
 * cwd is now repo B, and both would then fight over one agent_sessions row,
 * one prompt directory and one envelope.json.
 */
export function agentKey(agent: string, target: string): string {
  return `${agent}@${target}`;
}

/** Pull the final JSON object out of a response that may be wrapped in prose. */
export function extractJson(text: string): unknown {
  let candidate = text.trim();
  if (candidate.includes("```")) {
    const blocks = candidate.split("```");
    for (let i = 1; i < blocks.length; i += 2) {
      const block = (blocks[i] ?? "").replace(/^json\s*/i, "").trim();
      if (block.startsWith("{")) {
        candidate = block;
        break;
      }
    }
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("no JSON object found in the response");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function persistEnvelope(params: {
  run: Run;
  phase: Phase;
  agentName: string;
  /** `<agent>@<target>` — the directory this agent's run is filed under. */
  agentDirName: string;
  outputTypeName: string;
  envelope: EnvelopeBase | null;
  attempt: number;
  valid: boolean;
  raw?: string;
}): void {
  const payloadJson = params.envelope
    ? JSON.stringify(params.envelope, null, 2)
    : JSON.stringify({ raw: (params.raw ?? "").slice(-2000) });
  params.run.tracer.envelopeRow(
    params.phase,
    params.agentName,
    params.outputTypeName,
    payloadJson,
    params.valid,
    params.attempt,
  );
  if (!params.envelope) return;
  const dir = path.join(params.run.sessionDir, params.agentDirName);
  mkdirSync(dir, { recursive: true });
  const record = {
    agent_name: params.agentName,
    purpose: resolveAgent(params.run.cfg, params.agentName).purpose,
    output_type: params.outputTypeName,
    attempt: params.attempt,
    ...params.envelope,
  };
  writeFileSync(path.join(dir, "envelope.json"), JSON.stringify(record, null, 2));
}

/** One agent call, start to finish. */
export async function execute<S extends EnvelopeSchema>(
  run: Run,
  phase: Phase,
  call: AgentCall<S>,
  /** The repo this phase stands in. Defaults to the run's primary. */
  target: ResolvedTarget = run.target,
): Promise<z.infer<S>> {
  const agent = resolveAgent(run.cfg, phase.params.owner);
  const key = agentKey(agent.name, target.name);
  const agentDir = path.join(run.sessionDir, key);
  mkdirSync(agentDir, { recursive: true });

  // The repo brief is one file, inlined into every system prompt. Five copies
  // of the same domain description would drift within a week.
  const briefPath = path.join(run.promptRoot, "_repo_brief.md");
  const repoBrief = existsSync(briefPath) ? readFileSync(briefPath, "utf8").trim() : "";

  const variables: Record<string, string> = {
    repo_brief: repoBrief,
    prompt: call.prompt,
    previous_envelope: call.previous ? JSON.stringify(call.previous, null, 2) : "(none)",
    context_handoff_dir: run.handoffFor(target),
    handoff_root: run.contextHandoffDir,
    adw_id: run.adw_id,
    target: target.name,
    repo_root: target.path,
    subdir: target.subdir || "(whole repo)",
    scope_dir: target.scope,
    agent_name: agent.name,
  };

  const { system, user } = promptPaths(run.promptRoot, agent.name);
  const systemText = prompts.render(system, variables);
  const userText = prompts.render(user, variables);
  prompts.save(path.join(agentDir, "prompts"), "system.md", systemText);
  prompts.save(path.join(agentDir, "prompts"), "user.md", userText);

  // Copilot has no --system-prompt, so the system text becomes an --agent file
  // in a tree that holds nothing else. See identity.ts for why that matters.
  const identity = writeIdentity({
    dataDir: run.cfg.defaults.data_dir,
    agent,
    systemPromptPath: system,
    rendered: systemText,
  });

  const { id: sessionId, baseline } = sessionIdFor(run, agent, key);
  const tools = resolveTools(agent.coding_agent, agent.tools, agent.tools_extra);

  run.tracer.event({
    adw_id: run.adw_id,
    phase_id: phase.phase_id,
    type: "agent_start",
    name: agent.name,
    payload: {
      model: agent.model,
      thinking: agent.thinking,
      color: agent.color,
      session_id: sessionId,
      coding_agent: agent.coding_agent,
      purpose: agent.purpose,
      target: target.name,
      tools, // resolved vendor names; null = every tool the CLI has
      writes: agent.writes,
      identity_file: identity.file,
    },
  });
  run.console.agentStarted(agent.name, agent.model, sessionId);

  const spent: UsageBreakdown = emptyUsage();
  let latest: copilot.CopilotRunResult | null = null;
  let toolsOffered: string[] = [];

  const send = async (promptText: string): Promise<copilot.CopilotRunResult> => {
    const result = await copilot.run(
      {
        prompt: promptText,
        agentName: agent.name,
        model: agent.model,
        thinking: agent.thinking,
        sessionId,
        rawOutputPath: path.join(agentDir, "raw_output.jsonl"),
        tools,
        // Decision 7: cwd is the REPO ROOT even on a scoped target, so a
        // monorepo can be read across packages. `subdir` bounds writes, not reads.
        // On a cross-repo run this is the PHASE's repo — one agent, one tree,
        // still exactly one boundary to enforce.
        cwd: target.path,
        // Exactly two grants, and never the factory tree.
        addDirs: [identity.dir, run.sessionDir],
        homeDir: path.join(expandHome(run.cfg.defaults.data_dir), "id", agent.name, "copilot_home"),
      },
      latest ? latest.cumulative : baseline,
      {
        onToolCall: (record) => {
          run.tracer.event({
            adw_id: run.adw_id,
            phase_id: phase.phase_id,
            type: "tool_call",
            name: record.label,
            parent_id: record.parent_id ?? "",
            started_at: record.started_at ?? "",
            ended_at: record.ended_at ?? "",
            payload: { ...record, agent: agent.name },
          });
          run.console.toolCall(agent.name, record.label, record.ok, record.duration_ms);
        },
        onSpawn: (pid) =>
          run.tracer.processStart(
            run.adw_id,
            "agent",
            agent.name,
            pid,
            `copilot ${agent.name} ${agent.model}`,
          ),
        onExit: (pid) => run.tracer.processEnd(run.adw_id, pid),
      },
    );
    mergeUsage(spent, result.usage);
    run.addUsage(result.usage);
    if (result.toolsOffered.length && !toolsOffered.length) {
      toolsOffered = result.toolsOffered;
      // A model chooses its own tool dialect, so `--available-tools` is a
      // request rather than a guarantee. Record the difference the first time
      // it is visible: gpt-5.6-terra has no create/edit and writes via bash,
      // which is fine — but silently fine is how it stops being fine.
      const missing = missingFromOffer(tools, toolsOffered);
      if (missing.length) {
        run.tracer.event({
          adw_id: run.adw_id,
          phase_id: phase.phase_id,
          type: "log",
          name: "tool_dialect",
          payload: {
            agent: agent.name,
            model: agent.model,
            requested: tools,
            offered: toolsOffered,
            not_offered: missing,
          },
        });
        run.console.note(
          `${agent.name}: ${agent.model} does not offer ${missing.join(", ")} ` +
            `(it offers ${toolsOffered.length} tools) — this model's dialect differs`,
        );
      }
    }
    latest = result;
    return result;
  };

  const view = run.viewFor(target);

  // What both trees looked like before this agent got its hands on them. Every
  // send in this phase — first prompt, JSON retries, gate corrections — is
  // measured against this one baseline.
  const treeBefore = permissions.snapshot(target.path);

  let result = await send(userText);
  let parsed = await parseWithRetries(run, phase, call, key, result, send);
  let envelope = parsed.envelope;
  let attempt = parsed.attempt;

  // Claim gates — violations flow back into the SAME session as corrections.
  const retries = phase.params.retries;
  for (let gateAttempt = 1; gateAttempt <= Math.max(1, retries + 1) + 1; gateAttempt += 1) {
    const violations: string[] = [];
    for (const gate of call.gates ?? []) {
      // The VIEW, not the run: a gate reads `repoRoot` exactly as it always
      // has and gets the repo this phase is standing in.
      const report: GateReport = await gate(envelope, view);
      const found = report.violations;
      const gateName = gate.gateName ?? gate.name ?? "gate";
      run.tracer.gateRow(phase, gateName, report, gateAttempt);
      run.tracer.event({
        adw_id: run.adw_id,
        phase_id: phase.phase_id,
        type: found.length ? "gate_fail" : "gate_pass",
        name: gateName,
        payload: { attempt: gateAttempt, violations: found, checks: report.checks },
      });
      run.console.gateResult(gateName, report);
      violations.push(...found);
    }
    if (!violations.length) break;
    if (gateAttempt > retries) {
      throw new GateFailure(
        `${agent.name} failed gates after ${gateAttempt} attempt(s):\n- ${violations.join("\n- ")}`,
      );
    }
    phase.attempt = gateAttempt;
    run.console.retry(agent.name, gateAttempt, retries, `${violations.length} gate violation(s)`);
    result = await send(
      `Your previous response failed validation:\n- ${violations.join("\n- ")}\n\n` +
        `Fix these problems, then re-emit ONLY your Report JSON.`,
    );
    parsed = await parseWithRetries(run, phase, call, key, result, send);
    envelope = parsed.envelope;
    attempt = parsed.attempt;
  }

  // Permission is checked after every send is done, and BEFORE the envelope is
  // accepted: an agent does not get to report success on a phase in which it
  // wrote somewhere it was not allowed to.
  let touched: string[] = [];
  try {
    touched = permissions.enforce({
      repoRoot: target.path,
      subdir: target.subdir,
      agent,
      cfg: run.cfg,
      before: treeBefore,
    });
  } catch (breach) {
    run.tracer.event({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "error",
      name: "permission_breach",
      payload: {
        agent: agent.name,
        target: target.name,
        error: (breach as Error).message,
        writes: agent.writes,
        subdir: target.subdir,
        protected_files: run.cfg.defaults.protected_files,
      },
    });
    throw breach;
  }
  if (touched.length) {
    run.tracer.event({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "log",
      name: "paths_touched",
      payload: { agent: agent.name, paths: touched },
    });
  }

  persistEnvelope({
    run,
    phase,
    agentName: agent.name,
    agentDirName: key,
    outputTypeName: call.outputTypeName,
    envelope,
    attempt,
    valid: true,
  });
  run.console.envelopeSummary(call.outputTypeName, envelope);

  const context = latest as copilot.CopilotRunResult | null;
  run.tracer.agentSessionRow({
    adwId: run.adw_id,
    agent,
    // The row is keyed (adw_id, agent), so the KEY is what goes in that column:
    // two scouts over two repos are two sessions with two context figures, and
    // one row cannot honestly hold both.
    agentKey: key,
    target: target.name,
    sessionId,
    contextTokens: context?.contextTokens ?? 0,
    contextWindow: context?.contextWindow ?? 0,
    tools: toolsOffered,
  });
  run.saveAgentMap(key, {
    session_id: sessionId,
    model: agent.model,
    coding_agent: agent.coding_agent,
    premium_requests: context?.cumulative.premium_requests ?? 0,
    nano_aiu: context?.cumulative.nano_aiu ?? 0,
  });

  run.tracer.event({
    adw_id: run.adw_id,
    phase_id: phase.phase_id,
    type: "handoff",
    name: agent.name,
    payload: { artifacts: envelope.artifacts, summary: envelope.summary },
  });
  run.tracer.event({
    adw_id: run.adw_id,
    phase_id: phase.phase_id,
    type: "agent_end",
    name: agent.name,
    // Phase totals, not the last send's: a retried phase paid for every attempt.
    tokens: spent.prompt_tokens,
    payload: {
      usage: spent,
      context_tokens: context?.contextTokens ?? 0,
      context_window: context?.contextWindow ?? 0,
      tools_offered: toolsOffered,
      files_modified: context?.filesModified ?? [],
    },
  });
  run.console.agentFinished(agent.name, spent);

  if (envelope.status !== "success") {
    throw new Error(`${agent.name} reported status='${envelope.status}': ${envelope.summary}`);
  }
  return envelope;
}

/**
 * Parse the final response against the declared output type; on failure,
 * continue the SAME session with a correction (bounded).
 *
 * The correction names the exact fields, because Zod's error prose is terser
 * than pydantic's and a correction turn is only as good as the sentence that
 * provokes it (see utils.formatZodError).
 */
async function parseWithRetries<S extends EnvelopeSchema>(
  run: Run,
  phase: Phase,
  call: AgentCall<S>,
  agentDirName: string,
  first: copilot.CopilotRunResult,
  send: (prompt: string) => Promise<copilot.CopilotRunResult>,
): Promise<{ envelope: z.infer<S>; attempt: number }> {
  let result = first;
  for (let attempt = 1; attempt <= JSON_FIX_ATTEMPTS + 1; attempt += 1) {
    let detail: string;
    try {
      const payload = extractJson(result.text);
      const parsed = call.outputType.safeParse(payload);
      if (parsed.success) return { envelope: parsed.data as z.infer<S>, attempt };
      detail = formatZodError(parsed.error);
    } catch (error) {
      detail = (error as Error).message;
    }

    persistEnvelope({
      run,
      phase,
      agentName: phase.params.owner,
      agentDirName,
      outputTypeName: call.outputTypeName,
      envelope: null,
      attempt,
      valid: false,
      raw: result.text,
    });

    if (attempt > JSON_FIX_ATTEMPTS) {
      throw new Error(
        `${phase.params.owner} never produced valid ${call.outputTypeName} JSON: ${detail}`,
      );
    }
    run.console.retry(
      phase.params.owner,
      attempt,
      JSON_FIX_ATTEMPTS,
      `invalid ${call.outputTypeName} JSON: ${detail}`,
    );
    result = await send(
      `Your response was not valid JSON for the required structure.\n` +
        `Problem: ${detail}\n\n` +
        `Respond again with ONLY a JSON object matching ${call.outputTypeName}. ` +
        `No prose before or after it, no code fence.`,
    );
  }
  throw new Error("unreachable");
}
