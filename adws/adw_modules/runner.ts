/**
 * The Run object: config + adw_id + target + agent_map + tracer + console.
 *
 * `run.phase(...)` is the ONE phase primitive, for all three kinds (engineer,
 * agent, code). Decision 3: it is an `AsyncDisposable`, used as
 *
 *     {
 *       await using ph = run.phase({ name: "build", ... });
 *       await ph.call(...);
 *       ph.done();
 *     }
 *
 * ── How "success must be earned" survives the move off Python's `with` ───────
 * Python handed `__exit__` the exception, so SSSF could flip a phase to success
 * simply by not seeing one. JavaScript disposers are NOT given the in-flight
 * error — a disposer cannot tell a clean exit from a throw. Reproducing the old
 * shape would therefore mean marking success on the way out and hoping, which
 * is precisely the failure `run.finish()` was written to stop.
 *
 * So the earning is made explicit instead: a phase is born `fail`, and only
 * `ph.done()` flips it. Every `return`, `throw`, or `break` that skips that
 * line leaves the phase failed, which is the safe direction and is strictly
 * stricter than the Python it replaces. `ph.done()` is a one-word admission
 * that the work in the block actually finished.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";

import * as agents from "./agents.ts";
import type { AgentMapEntry } from "./agents.ts";
import { Console } from "./console.ts";
import type { Tracer } from "./tracer.ts";
import {
  emptyUsage,
  mergeUsage,
  PhaseParams as PhaseParamsSchema,
  type AgentCall,
  type EnvelopeSchema,
  type Phase,
  type PhaseParams,
  type ResolvedTarget,
  type SfoConfig,
  type UsageBreakdown,
} from "./types.ts";
import { ensureDir, expandHome, formatZodError, nowIso } from "./utils.ts";

export class PhaseHandle implements AsyncDisposable {
  private finalized = false;
  private readonly clock = performance.now();

  constructor(
    private readonly run: Run,
    readonly phase: Phase,
  ) {}

  /** Record detail inside this phase — printed and traced together. */
  log(payload: Record<string, unknown>): void {
    this.run.tracer.event({
      adw_id: this.run.adw_id,
      phase_id: this.phase.phase_id,
      type: "log",
      name: this.phase.params.name,
      payload,
    });
    this.run.console.note(
      Object.entries(payload)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", "),
    );
    if (this.phase.params.kind === "engineer" && "input" in payload) {
      this.run.tracer.sessionRequest(this.run.adw_id, String(payload["input"]));
    }
  }

  async call<S extends EnvelopeSchema>(call: AgentCall<S>): Promise<z.infer<S>> {
    if (this.phase.params.kind !== "agent") {
      throw new Error("ph.call() is only valid inside an agent phase");
    }
    try {
      return await agents.execute(this.run, this.phase, call);
    } catch (error) {
      // Record it here, where the message still exists: the disposer is not
      // handed the in-flight error and would otherwise write an empty reason.
      this.fail(error);
      throw error;
    }
  }

  /** Attach a failure reason without ending the phase. */
  fail(error: unknown): void {
    this.phase.error = String((error as Error)?.message ?? error).slice(0, 1000);
  }

  /** Success, earned. Skipping this line leaves the phase failed. */
  done(): void {
    this.phase.status = "success";
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const ok = this.phase.status === "success";
    this.phase.ended_at = nowIso();
    if (!ok) {
      this.phase.status = "fail";
      this.run.tracer.event({
        adw_id: this.run.adw_id,
        phase_id: this.phase.phase_id,
        type: "error",
        name: this.phase.params.name,
        payload: { error: this.phase.error ?? "phase did not reach ph.done()" },
      });
    }
    this.run.tracer.event({
      adw_id: this.run.adw_id,
      phase_id: this.phase.phase_id,
      type: "phase_end",
      name: this.phase.params.name,
      payload: { status: this.phase.status },
    });
    this.run.tracer.phaseUpsert(this.phase);
    this.run.console.phaseEnded(this.phase, (performance.now() - this.clock) / 1000);
    this.run.closePhase(this.phase);
  }
}

export interface RunInit {
  cfg: SfoConfig;
  adwId: string;
  tracer: Tracer;
  engineer: string;
  target: ResolvedTarget;
  promptRoot: string;
}

export class Run {
  readonly cfg: SfoConfig;
  readonly adw_id: string;
  readonly tracer: Tracer;
  readonly console: Console;
  readonly engineer: string;
  readonly target: ResolvedTarget;
  readonly promptRoot: string;
  readonly phases: Phase[] = [];
  readonly usage: UsageBreakdown = emptyUsage();
  readonly sessionDir: string;
  readonly contextHandoffDir: string;

  agentMap: Record<string, AgentMapEntry> = {};
  private seq: number;
  private openPhase: Phase | null = null;
  private readonly agentMapPath: string;

  constructor(init: RunInit) {
    this.cfg = init.cfg;
    this.adw_id = init.adwId;
    this.tracer = init.tracer;
    this.engineer = init.engineer;
    this.target = init.target;
    this.promptRoot = init.promptRoot;
    this.console = new Console(init.tracer, init.adwId);
    this.seq = init.tracer.maxPhaseSeq(init.adwId); // a joined run continues the sequence

    const dataDir = expandHome(init.cfg.defaults.data_dir);
    this.sessionDir = ensureDir(path.join(dataDir, "sessions", init.adwId));
    this.contextHandoffDir = ensureDir(path.join(this.sessionDir, "context_handoff"));
    this.agentMapPath = path.join(this.sessionDir, "agent_map.json");
    if (existsSync(this.agentMapPath)) {
      try {
        this.agentMap = JSON.parse(readFileSync(this.agentMapPath, "utf8"));
      } catch {
        this.agentMap = {};
      }
    }
  }

  /** The target repo root — where every agent is spawned to work. */
  get repoRoot(): string {
    return this.target.path;
  }

  // ── agent map (adw_id -> per-agent session ids + usage baselines) ──────────
  saveAgentMap(agent: string, entry: AgentMapEntry): void {
    this.agentMap[agent] = entry;
    mkdirSync(path.dirname(this.agentMapPath), { recursive: true });
    writeFileSync(this.agentMapPath, JSON.stringify(this.agentMap, null, 2));
  }

  // ── usage (run totals mirror what the tracer accumulates in sqlite) ────────
  addUsage(usage: UsageBreakdown): void {
    mergeUsage(this.usage, usage);
    this.tracer.sessionAddUsage(this.adw_id, usage);
  }

  // ── the phase primitive ────────────────────────────────────────────────────
  phase(params: PhaseParams | Record<string, unknown>): PhaseHandle {
    // Parsed here, not by the caller: the description rule must fire BEFORE the
    // phase opens, so a bad description never reaches the trace at all.
    const validated = PhaseParamsSchema.safeParse(params);
    if (!validated.success) {
      throw new Error(`invalid phase params: ${formatZodError(validated.error)}`);
    }
    const p = validated.data;
    this.seq += 1;
    const phase: Phase = {
      phase_id: `${this.adw_id}_${String(this.seq).padStart(2, "0")}_${p.name}`,
      adw_id: this.adw_id,
      seq: this.seq,
      params: p,
      status: "fail", // success must be earned
      attempt: 0,
      started_at: nowIso(),
    };
    this.phases.push(phase);
    this.openPhase = phase;
    this.tracer.phaseUpsert({ ...phase, status: "running" });
    this.tracer.event({
      adw_id: this.adw_id,
      phase_id: phase.phase_id,
      type: "phase_start",
      name: p.name,
      payload: { kind: p.kind, owner: p.owner, description: p.description },
    });
    this.console.phaseStarted(phase);
    return new PhaseHandle(this, phase);
  }

  closePhase(phase: Phase): void {
    if (this.openPhase === phase) this.openPhase = null;
  }

  /**
   * Amend the phase that was in flight when an unexpected error escaped.
   *
   * The disposer has already written the row by the time the error reaches the
   * ADW's catch, but `phaseUpsert` is an upsert — so the reason can still be
   * attached to the right phase rather than lost to the console.
   */
  recordFailure(error: unknown): void {
    const phase = this.openPhase ?? this.phases[this.phases.length - 1];
    if (!phase || phase.status === "success") return;
    if (!phase.error) {
      phase.error = String((error as Error)?.message ?? error).slice(0, 1000);
      this.tracer.phaseUpsert(phase);
    }
  }

  // ── run outcome ────────────────────────────────────────────────────────────
  /**
   * Finalize the run and return its exit code. Call this exactly once.
   *
   * Two criteria, not one. Every phase must have passed, AND the ADW's own
   * acceptance test must hold. They are different questions on purpose: a test
   * phase that ran the suite did its job even when the suite came back red, so
   * the PHASE succeeds while the RUN must not.
   *
   * One call settles the db, the banner, and the exit code together, so the
   * three cannot disagree — SSSF shipped a version where they did, recording a
   * run green everywhere while exiting 1.
   */
  finish(accepted = true, reason = ""): number {
    const phasesOk = this.phases.length > 0 && this.phases.every((p) => p.status === "success");
    const ok = phasesOk && accepted;
    if (phasesOk && !accepted) {
      const note = reason || "the run's acceptance criterion was not met";
      this.tracer.event({
        adw_id: this.adw_id,
        phase_id: this.phases[this.phases.length - 1]?.phase_id ?? "",
        type: "error",
        name: "not_accepted",
        payload: { reason: note },
      });
      this.console.note(`not accepted: ${note}`);
    }
    this.tracer.sessionFinish(this.adw_id, ok);
    this.console.sessionFinished(ok, this.usage, this.tracer.dbPath);
    return ok ? 0 : 1;
  }
}
