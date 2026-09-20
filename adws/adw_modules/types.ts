/**
 * Every type the factory shares, in one file.
 *
 * This is the single definition: the engine imports it, the ADW chains import
 * it, and the visualizer imports it. SSSF kept `data_types.py` and the UI's
 * `shared/types.ts` in sync by hand and they drifted. One language, one file.
 *
 * Zod rather than bare TypeScript because agent output arrives as untrusted
 * JSON that must be PARSED, not asserted. `.parse()` is the seam where an
 * agent's claim becomes a typed value — and where a malformed one turns into a
 * correction prompt instead of a runtime crash three phases later.
 */

import { z } from "zod";

// ── Phases ───────────────────────────────────────────────────────────────────

export const PhaseKind = z.enum(["engineer", "agent", "code"]);
export type PhaseKind = z.infer<typeof PhaseKind>;

export const PhaseStatus = z.enum(["queued", "running", "success", "fail"]);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

/**
 * Everything run.phase() needs. Passed as one object, never loose params
 * (hard rule 4: >4 params -> take one typed object instead).
 */
export const PhaseParams = z
  .object({
    name: z.string().min(1), // short id, unique within the run: "plan", "build"
    kind: PhaseKind, // which lane the block renders in
    owner: z.string().min(1), // engineer's name, "git", or an agent from the roster
    description: z.string(), // REQUIRED: what this phase does and why — see below
    retries: z.number().int().min(0).default(0), // gate-failure correction turns
  })
  .superRefine((params, ctx) => {
    // A phase name identifies; a description explains. Both are required.
    //
    // The description is the only sentence the trace, the console and the phase
    // block in the UI ever show about intent — everything else is ids, statuses
    // and timings. `commit_plan: "Commit the plan"` tells a reader nothing they
    // could not already see, so an echo is rejected the same way a blank one
    // is. This fires before the phase opens, not after a run is in the trace.
    const text = params.description.split(/\s+/).filter(Boolean).join(" ");
    if (!text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["description"],
        message:
          `phase '${params.name}': description is required — one sentence on ` +
          `what this phase does and why. It is what the trace and the UI show.`,
      });
      return;
    }
    const restates =
      text.replace(/\.+$/, "").toLowerCase() ===
      params.name.replace(/_/g, " ").toLowerCase();
    if (restates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["description"],
        message:
          `phase '${params.name}': description '${text}' only restates the ` +
          `phase name — say what it does and why instead.`,
      });
    }
  })
  // Normalize after validating, so what reaches the console, the trace and the
  // phase block in the UI is one clean line. A description written across three
  // indented source lines is still one sentence; it should not render as three.
  .transform((params) => ({
    ...params,
    description: params.description.split(/\s+/).filter(Boolean).join(" "),
  }));
export type PhaseParams = z.infer<typeof PhaseParams>;

/** The persisted phase record — PhaseParams plus lifecycle. */
export interface Phase {
  phase_id: string;
  adw_id: string;
  seq: number;
  params: PhaseParams;
  status: PhaseStatus; // starts "fail" — success must be earned
  attempt: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
}

// ── Envelopes (agent output types) ───────────────────────────────────────────

/** Base of every agent's final JSON response. Output types extend this. */
export const EnvelopeBase = z.object({
  status: z.enum(["success", "fail"]),
  summary: z.string().default(""),
  artifacts: z.array(z.string()).default([]),
  notes_for_next_agent: z.string().default(""),
});
export type EnvelopeBase = z.infer<typeof EnvelopeBase>;

export const GenericOutput = EnvelopeBase.extend({});
export type GenericOutput = z.infer<typeof GenericOutput>;

export const PlanOutput = EnvelopeBase.extend({
  // Subject for committing the PLAN — the spec file the planner wrote, not the
  // implementation it describes. Each agent's commit_message covers its own
  // work product, so a chain that commits per step never reuses one agent's
  // words for another agent's diff.
  commit_message: z.string().default(""),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

export const BuildOutput = EnvelopeBase.extend({
  changed_files: z.array(z.string()).default([]),
  commit_message: z.string().default(""), // consumed by the git commit phase
});
export type BuildOutput = z.infer<typeof BuildOutput>;

export const ScoutFinding = z.object({
  file: z.string(),
  note: z.string().default(""),
});
export type ScoutFinding = z.infer<typeof ScoutFinding>;

export const ScoutOutput = EnvelopeBase.extend({
  findings: z.array(ScoutFinding).default([]),
});
export type ScoutOutput = z.infer<typeof ScoutOutput>;

/** One thing the request (or plan) asked for, and whether it is there. */
export const ReviewFinding = z.object({
  requirement: z.string(), // the ask, in the requester's words
  met: z.boolean(),
  evidence: z.string().default(""), // where it lives, or what is missing
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** Confirmation that what was built is what was asked for — not a test run. */
export const ReviewOutput = EnvelopeBase.extend({
  approved: z.boolean().default(false),
  findings: z.array(ReviewFinding).default([]),
  blocking: z.array(z.string()).default([]), // what must change before approval
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** Where the write-up of a completed change landed. */
export const DocumentOutput = EnvelopeBase.extend({
  document_path: z.string().default(""), // e.g. app_docs/<adw_id>_<slug>.md
  documented_files: z.array(z.string()).default([]),
  commit_message: z.string().default(""),
});
export type DocumentOutput = z.infer<typeof DocumentOutput>;

/**
 * A deterministic result, shaped as an envelope so an agent can consume it.
 *
 * Agents hand each other typed envelopes; code blocks return QualityResult.
 * This is the adapter, so a failing lint or test run flows back into the
 * builder through exactly the same door a tester agent's report used to — the
 * ADW script is the only thing that knows the difference.
 */
export const VerifyOutput = EnvelopeBase.extend({
  passed: z.boolean().default(false),
  failures: z.array(z.string()).default([]),
});
export type VerifyOutput = z.infer<typeof VerifyOutput>;

/** A ChangeSet shaped as an envelope so an agent can be handed it directly. */
export const ChangesOutput = EnvelopeBase.extend({
  base: z.string().default(""), // "<ref> @ <commit> — <reason>"
  changed_files: z.array(z.string()).default([]),
  insertions: z.number().default(0),
  deletions: z.number().default(0),
  stat: z.string().default(""),
  diff_path: z.string().default(""), // read this for the full diff
});
export type ChangesOutput = z.infer<typeof ChangesOutput>;

/**
 * Any envelope schema an AgentCall may declare as its `outputType`.
 *
 * The INPUT is `unknown` on purpose: what arrives is a parsed blob of agent
 * JSON, and the whole job of `.safeParse()` at that seam is to turn an
 * unverified claim into a typed value. Constraining the input to the output
 * shape would assume the very thing being checked.
 */
export type EnvelopeSchema = z.ZodType<
  EnvelopeBase & Record<string, unknown>,
  z.ZodTypeDef,
  unknown
>;

// ── Deterministic quality blocks ─────────────────────────────────────────────

export const QualityArea = z.enum(["frontend", "backend", "repo"]);
export type QualityArea = z.infer<typeof QualityArea>;

export const QualityOperation = z.enum(["lint", "typecheck", "build", "test"]);
export type QualityOperation = z.infer<typeof QualityOperation>;

/** One deterministic quality command. */
export interface QualityCheckSpec {
  name: string;
  area: QualityArea;
  operation: QualityOperation;
  argv: string[];
  cwd: string;
  timeout_seconds: number;
}

/** Captured evidence from one quality command. */
export interface QualityCheckResult {
  name: string;
  area: QualityArea;
  operation: QualityOperation;
  command: string;
  returncode: number;
  passed: boolean;
  duration_seconds: number;
  output_artifact: string;
  /**
   * The tail of stdout+stderr, verbatim and unparsed. A failure has to travel
   * back to the builder as an envelope, and the builder cannot open a log file
   * it was never handed — so the evidence rides along. Deliberately raw: every
   * runner formats failures differently and a generic parser would be
   * confidently wrong. The full log is always at output_artifact.
   */
  output_tail: string;
}

/** Aggregate result from a quality block: every check it ran, and the verdict. */
export interface QualityResult {
  passed: boolean;
  checks: QualityCheckResult[];
  failures: string[];
  artifacts: string[];
}

// ── Change capture (git diff, deterministic) ─────────────────────────────────

/** Everything changes.capture() needs. One object, never loose params. */
export interface ChangeCapture {
  base: string; // the ref the work is measured against
  max_diff_lines?: number; // the diff artifact is truncated past this
  include_untracked?: boolean; // a brand-new file is part of the change
}

/**
 * The commit a change is measured from, and why that one.
 *
 * `reason` is the line the trace shows. A diff is only as trustworthy as the
 * thing it was taken against, so the ADW records that choice instead of
 * leaving the reader to infer it.
 */
export interface BaseRef {
  ref: string; // what was asked for: "main", or a pinned sha
  commit: string; // the commit actually diffed against
  reason: string;
}

/** Display form — a named ref as itself, a pinned raw sha shortened. */
export function baseRefLabel(base: BaseRef): string {
  return /^[0-9a-f]{40}$/.test(base.ref) ? base.ref.slice(0, 7) : base.ref;
}

/** What changed since the base commit — pure git facts, no judgement. */
export interface ChangeSet {
  base: BaseRef;
  files: string[];
  untracked: string[];
  insertions: number;
  deletions: number;
  stat: string; // `git diff --stat` output, verbatim
  diff_path: string; // the full diff, written into context_handoff/
  truncated: boolean;
}

// ── Gates ────────────────────────────────────────────────────────────────────

/**
 * One thing a gate looked at, and what it found.
 *
 * `note` is the evidence — "exists, 2.1KB", "exit 0", "not in the diff". On a
 * failed check it doubles as the reason, so it is what the agent is told.
 */
export interface GateCheck {
  item: string; // what was checked: a path, a command, a test
  ok: boolean;
  note: string;
}

/**
 * What every gate returns: the checks it ran. Violations are derived.
 *
 * Authoring stays a one-liner per item — `report.check(...)` appends and
 * returns `this`, so a gate is a loop and a return.
 */
export class GateReport {
  readonly checks: GateCheck[] = [];

  check(item: string, ok: boolean, note = ""): this {
    this.checks.push({ item, ok, note });
    return this;
  }

  get violations(): string[] {
    return this.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.item}: ${c.note || "failed"}`);
  }

  get passed(): boolean {
    return this.violations.length === 0;
  }
}

/** A gate verifies an envelope's claims AFTER the fact, never predictions. */
export interface Gate<T extends EnvelopeBase = EnvelopeBase> {
  (envelope: T, run: RunLike): GateReport | Promise<GateReport>;
  gateName?: string;
}

// ── Agent calls ──────────────────────────────────────────────────────────────

/** One agent invocation: prompt in, typed envelope out, gates verified. */
export interface AgentCall<S extends EnvelopeSchema = EnvelopeSchema> {
  outputType: S;
  /** The name the correction prompt uses for this shape, e.g. "BuildOutput". */
  outputTypeName: string;
  prompt: string;
  previous?: EnvelopeBase | undefined;
  gates?: Gate<z.infer<S>>[];
}

// ── Config ───────────────────────────────────────────────────────────────────

export const CodingAgent = z.enum(["copilot", "claude"]);
export type CodingAgent = z.infer<typeof CodingAgent>;

export const Thinking = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type Thinking = z.infer<typeof Thinking>;

export const AgentConfig = z.object({
  name: z.string().min(1),
  coding_agent: CodingAgent.default("copilot"),
  model: z.string().default("gemini-3.6-flash"),
  thinking: Thinking.default("medium"),
  color: z.string().default(""), // hex swatch for this agent's lane in the UI
  purpose: z.string().default(""),
  /**
   * Neutral tool vocabulary — `read`, `write`, `search`, `shell`, … — mapped
   * to each vendor's real names by tool_map.ts. `null` means all tools.
   * Decision 8: a roster entry stays readable by both adapters.
   */
  tools: z.array(z.string()).nullable().default(null),
  /** Vendor-specific tool names passed through verbatim, escape hatch for #8. */
  tools_extra: z.array(z.string()).default([]),
  /**
   * What this agent may MODIFY in the target repo, enforced in code after every
   * call (see permissions.ts). `tools` cannot express this: `bash` runs
   * anything and `create` reaches any path, so an agent's capability list is a
   * statement of intent that nothing checks.
   *   null  -> unrestricted, except the roster-wide `protected_files`
   *   []    -> read-only: may modify nothing tracked
   *   [...] -> only these. A trailing "/" is a directory prefix; "*" makes it
   *            a glob; anything else is an exact path.
   */
  writes: z.array(z.string()).nullable().default(null),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const ConfigDefaults = z.object({
  coding_agent: CodingAgent.default("copilot"),
  model: z.string().default("gemini-3.6-flash"),
  thinking: Thinking.default("medium"),
  color: z.string().default(""),
  tools: z.array(z.string()).nullable().default(null),
  tools_extra: z.array(z.string()).default([]),
  /**
   * Off-limits to every agent that has not named them in its own `writes`.
   * The factory now lives OUTSIDE every target repo (see the factory/runtime
   * split), so this is empty by default — permissions.ts watches the factory
   * tree as a tripwire instead, where ANY change is a breach.
   */
  protected_files: z.array(z.string()).default([]),
  /** Runtime root. Outside the factory tree, on purpose. */
  data_dir: z.string().default("~/.sfo-build"),
});
export type ConfigDefaults = z.infer<typeof ConfigDefaults>;

export const ObservabilityConfig = z.object({
  db: z.string().default("~/.sfo-build/sfo.db"),
  poll_ms: z.number().int().positive().default(500),
});
export type ObservabilityConfig = z.infer<typeof ObservabilityConfig>;

/**
 * One repo (or one scope within one repo) the factory can drive.
 *
 * Flat registry, by decision 1: `--target NAME` picks the row. Two targets may
 * share a `path` — `api` and `front` both live in the oms monorepo — which is
 * why the concurrency lock is keyed on the resolved PATH, not the name.
 */
export const TargetConfig = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  /**
   * A soft scope, by decision 7. The agent's cwd is always the repo root so a
   * monorepo can be read across packages; `subdir` constrains what the builder
   * may WRITE and where quality commands run — not what must pass.
   */
  subdir: z.string().default(""),
  /** Real argv from the registry, never a placeholder (see quality.ts). */
  test: z.array(z.string()).default([]),
  lint: z.array(z.string()).default([]),
  typecheck: z.array(z.string()).default([]),
  build: z.array(z.string()).default([]),
});
export type TargetConfig = z.infer<typeof TargetConfig>;

/**
 * Context ceilings, DECLARED rather than measured.
 *
 * Copilot exposes `--context` as a tier and ships no catalog, so the harness
 * can never report a window size (known impossibility 4) and `context_window`
 * on an agent_sessions row stays 0. A ceiling therefore has to come from the
 * operator, which is what this map is: a statement the operator owns, in the
 * same file as the roster, that the UI attributes to this file rather than to
 * the stream. An unlisted model has no ceiling and gets no percentage — the
 * same fail-closed default as everywhere else, not a guessed denominator.
 */
export const ModelConfig = z.object({
  context_window: z.number().int().positive(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const SfoConfig = z.object({
  defaults: ConfigDefaults.default({}),
  observability: ObservabilityConfig.default({}),
  models: z.record(z.string(), ModelConfig).default({}),
  agents: z.array(AgentConfig).default([]),
  targets: z.array(TargetConfig).default([]),
});
export type SfoConfig = z.infer<typeof SfoConfig>;

// ── Tracing ──────────────────────────────────────────────────────────────────

/** One traced event, always logged against adw_id + phase. */
export interface EventRecord {
  adw_id: string;
  phase_id?: string;
  /** phase_start | agent_start | tool_call | handoff | gate_pass | gate_fail |
   *  log | agent_end | phase_end | error */
  type: string;
  name?: string;
  payload?: Record<string, unknown>;
  /** Copilot gives every event a parentId — a native span tree, kept as-is. */
  parent_id?: string;
  tokens?: number | null;
  /**
   * Spans: set both when an event covers real elapsed time (a tool call), so
   * the UI lays it out on a time axis without parsing payload JSON. Left unset,
   * the tracer stamps started_at with the moment the event was recorded.
   */
  started_at?: string;
  ended_at?: string;
}

// ── Coding agent interface ───────────────────────────────────────────────────

/** Everything one non-interactive coding-agent run needs. */
export interface AgentRequest {
  prompt: string;
  agentName: string;
  model: string;
  thinking: Thinking;
  /** UUIDv5 derived from (adw_id, agent) — deterministic, so resume works. */
  sessionId: string;
  /** Where raw JSONL lands, for the audit record. */
  rawOutputPath: string;
  tools: string[] | null;
  /** cwd — the TARGET REPO ROOT. Decision 7. */
  cwd: string;
  /**
   * Exactly the directories this call may reach outside cwd: the agent's own
   * identity dir and this run's session dir. NEVER the factory tree.
   */
  addDirs: string[];
  /** Per-agent COPILOT_HOME, so agents cannot read each other's state. */
  homeDir: string;
}

/**
 * Tokens and spend for one call.
 *
 * Copilot exposes no `total_cost` FIELD, but `nano_aiu` is nonetheless money:
 * GitHub documents `totalNanoAiu` as the session's AI-credit cost and prices a
 * credit at $0.01. So dollars are stored as the unit the stream actually
 * reports and derived on read by `usd()` — never written as a second column
 * that could drift from the number it was computed from.
 */
export interface UsageBreakdown {
  prompt_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  premium_requests: number;
  nano_aiu: number;
}

export function emptyUsage(): UsageBreakdown {
  return {
    prompt_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    premium_requests: 0,
    nano_aiu: 0,
  };
}

/**
 * Dollars from nano-AI units.
 *
 * 1e9 nanoAIU is one AI credit and one AI credit is $0.01, so this is a unit
 * conversion, not a price model. Premium requests are deliberately excluded:
 * they are the older per-request unit, they cost nothing until a plan's monthly
 * allowance is spent, and adding the $0.04 overage rate on top would bill the
 * same work twice.
 */
export const USD_PER_AI_CREDIT = 0.01;

export function aiCredits(nanoAiu: number): number {
  return nanoAiu / 1e9;
}

export function usd(nanoAiu: number): number {
  return aiCredits(nanoAiu) * USD_PER_AI_CREDIT;
}

/** A run lands in cents, one agent call in fractions of one. */
export function money(nanoAiu: number): string {
  const value = usd(nanoAiu);
  if (!value) return "$0";
  if (value < 0.001) return "<$0.001";
  return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

export function mergeUsage(into: UsageBreakdown, other: UsageBreakdown): void {
  into.prompt_tokens += other.prompt_tokens;
  into.cache_read_tokens += other.cache_read_tokens;
  into.cache_write_tokens += other.cache_write_tokens;
  // Both are session-cumulative gauges in Copilot's stream, so the adapter
  // already reduces them to this call's delta before they arrive here.
  into.premium_requests += other.premium_requests;
  into.nano_aiu += other.nano_aiu;
}

export interface AgentResult {
  text: string;
  returncode: number;
  sessionId: string;
  usage: UsageBreakdown;
  /**
   * Window occupancy after the last turn. Copilot exposes `--context` as a
   * TIER, not a number, and ships no catalog to read a ceiling from, so
   * `contextWindow` stays 0 for Copilot (known impossibility 4).
   */
  contextTokens: number;
  contextWindow: number;
  /** Tool names the model was actually offered, from usage_checkpoint. */
  toolsOffered: string[];
  filesModified: string[];
}

// ── Run (structural type, so gates/quality need not import runner.ts) ────────

export interface RunLike {
  cfg: SfoConfig;
  adw_id: string;
  target: ResolvedTarget;
  repoRoot: string;
  sessionDir: string;
  contextHandoffDir: string;
  console: { note(message: string): void };
  tracer: { event(record: EventRecord): string };
  phases: Phase[];
}

/** A target row with every path resolved to an absolute location on disk. */
export interface ResolvedTarget {
  name: string;
  /** Absolute repo root. Agents are spawned here. */
  path: string;
  /** Absolute `path`/`subdir`, or `path` when there is no subdir. */
  scope: string;
  /** The `subdir` as written in the registry, "" when unscoped. */
  subdir: string;
  test: string[];
  lint: string[];
  typecheck: string[];
  build: string[];
}
