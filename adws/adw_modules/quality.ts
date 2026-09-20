/**
 * Deterministic lint, typecheck, build, and test blocks.
 *
 * Hard rule 8: a known command is CODE, not an agent. Anything whose
 * invocation you can write down belongs here — it runs in seconds, costs
 * nothing, and returns the same answer every time. Agents are for the parts
 * that need reading and deciding. An agent rediscovering `nx run-many -t test`
 * on every run spends a context window learning what a subprocess already knows.
 *
 * ── No placeholders. Ever. ───────────────────────────────────────────────────
 * SSSF shipped these blocks as `echo PLACEHOLDER ... && exit 0`, and that is
 * its number one shipped failure mode: a wrong-but-plausible command that
 * silently passes is worse than no command at all, because the whole chain
 * downstream believes it. Here the argv comes from the TARGET REGISTRY, and a
 * target with no command for an operation is a hard error at the call site —
 * never a green tick nobody earned.
 *
 * Two rules the registry entries follow:
 *   1. argv LIST, never a shell string — no quoting bugs, no shell injection.
 *   2. Binaries by BARE NAME. These inherit the operator's environment, so
 *      `npx`, `node`, `bun` resolve exactly as they do in their terminal.
 *      Never an absolute path — that bakes one machine into the trace.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  QualityCheckResult,
  QualityCheckSpec,
  QualityOperation,
  QualityResult,
  ResolvedTarget,
  VerifyOutput,
} from "./types.ts";
import type { Run } from "./runner.ts";
import { nowIso, operatorEnv, shellJoin } from "./utils.ts";

/**
 * How much of a failing command's output rides back inside the envelope.
 * Enough for a builder to act on without opening the artifact; bounded so a
 * runaway stack trace cannot swamp the next agent's context.
 */
const TAIL_CHARS = 4_000;

const TIMEOUTS: Record<QualityOperation, number> = {
  test: 900,
  lint: 300,
  typecheck: 300,
  build: 900,
};

export class MissingCommandError extends Error {}

/** Pull one operation's argv off the resolved target, or refuse. */
export function specFor(target: ResolvedTarget, operation: QualityOperation): QualityCheckSpec {
  const argv = target[operation];
  if (!argv.length) {
    throw new MissingCommandError(
      `target '${target.name}' has no '${operation}' command configured.\n\n` +
        `Add one to adws/adw_sfo_config/sfo.config.yaml as an argv LIST, e.g.\n` +
        `      ${operation}: [npx, nx, run-many, -t, ${operation}]\n\n` +
        `This is deliberately an error rather than a no-op: a quality block that ` +
        `exits 0 without running anything reports green for work nobody checked.`,
    );
  }
  return {
    name: operation,
    // `subdir` names the package, so a scoped target reports its own area.
    area: target.subdir.includes("front") ? "frontend" : target.subdir ? "backend" : "repo",
    operation,
    argv,
    // Decision: commands run in the target's SCOPE (path/subdir). Verified that
    // nx resolves its workspace root upward from a package directory, so a
    // repo-wide `run-many` still covers all three projects from apps/api.
    cwd: target.scope,
    timeout_seconds: TIMEOUTS[operation],
  };
}

function checkDir(run: Run, name: string): string {
  const seq = run.phases[run.phases.length - 1]?.seq ?? 0;
  const dir = path.join(
    run.contextHandoffDir,
    "quality",
    `${String(seq).padStart(2, "0")}_${name}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runSpec(spec: QualityCheckSpec, run: Run): QualityCheckResult {
  const phase = run.phases[run.phases.length - 1]!;
  const outputArtifact = path.join(checkDir(run, spec.name), "command.log");
  const command = shellJoin(spec.argv);

  run.console.note(`quality ${spec.name}: ${command}`);
  const startedAt = nowIso();
  const clock = performance.now();

  const result = spawnSync(spec.argv[0]!, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: operatorEnv(),
    encoding: "utf8",
    timeout: spec.timeout_seconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });

  let stdout = result.stdout ?? "";
  let stderr = result.stderr ?? "";
  let returncode: number;
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    returncode = 124;
    stderr += `\nTimed out after ${spec.timeout_seconds}s.`;
  } else if (result.error) {
    // A missing binary lands here with the real message — no pre-flight probe
    // needed, and none wanted.
    returncode = 127;
    stderr += `\n${result.error.message}`;
  } else {
    returncode = result.status ?? 1;
  }

  const duration = (performance.now() - clock) / 1000;
  writeFileSync(
    outputArtifact,
    `$ ${command}\ncwd: ${spec.cwd}\nexit: ${returncode}\n` +
      `duration_seconds: ${duration.toFixed(3)}\n\n` +
      `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
  );

  const passed = returncode === 0;
  run.tracer.event({
    adw_id: run.adw_id,
    phase_id: phase.phase_id,
    type: "tool_call",
    name: `quality:${spec.name}`,
    started_at: startedAt,
    ended_at: nowIso(),
    payload: {
      area: spec.area,
      operation: spec.operation,
      command,
      cwd: spec.cwd,
      returncode,
      passed,
      output_artifact: outputArtifact,
    },
  });
  run.console.note(
    `quality ${spec.name}: ${passed ? "passed" : "failed"} (exit ${returncode}, ${duration.toFixed(1)}s)`,
  );

  return {
    name: spec.name,
    area: spec.area,
    operation: spec.operation,
    command,
    returncode,
    passed,
    duration_seconds: duration,
    output_artifact: outputArtifact,
    output_tail: `${stdout}${stderr}`.slice(-TAIL_CHARS),
  };
}

/** A failure is the command, its exit code, and what it actually printed. */
function failureText(check: QualityCheckResult): string {
  return `${check.name}: \`${check.command}\` exited ${check.returncode}\n${check.output_tail}`.trimEnd();
}

function collect(checks: QualityCheckResult[]): QualityResult {
  const failures = checks.filter((c) => !c.passed).map(failureText);
  return {
    passed: failures.length === 0,
    checks,
    failures,
    artifacts: checks.map((c) => c.output_artifact),
  };
}

/**
 * The test suite alone — the deterministic test phase.
 *
 * This is what replaces a `tester` agent once the command is written down. The
 * repair loop is unchanged, because a failure still reaches the builder through
 * `asEnvelope` below.
 */
export function runTests(run: Run): QualityResult {
  return collect([runSpec(specFor(run.target, "test"), run)]);
}

/**
 * Run several blocks and collect ALL failures — one pass tells you everything.
 *
 * Ordering contract for the caller: a failing block does NOT fail the phase.
 * The runner did its job; the CODE is what failed. Hand this result to the
 * builder and let the bounded repair loop decide the run's fate.
 */
export function runQuality(run: Run, operations: QualityOperation[]): QualityResult {
  return collect(operations.map((op) => runSpec(specFor(run.target, op), run)));
}

/** Only the operations this target actually configured. */
export function configured(target: ResolvedTarget, operations: QualityOperation[]): QualityOperation[] {
  return operations.filter((op) => target[op].length > 0);
}

/**
 * Wrap a deterministic result so an agent can be handed it directly.
 *
 * Agents hand each other typed envelopes; code blocks return QualityResult.
 * This is the adapter, so a failing suite flows back into the builder through
 * exactly the same door an agent's report would — the ADW script is the only
 * thing that knows the difference.
 */
export function asEnvelope(result: QualityResult, what: string): VerifyOutput {
  return {
    status: result.passed ? "success" : "fail",
    summary: result.passed
      ? `${what}: all ${result.checks.length} check(s) passed`
      : `${what}: ${result.failures.length} of ${result.checks.length} check(s) failed`,
    artifacts: result.artifacts,
    notes_for_next_agent: result.passed
      ? ""
      : "Fix every failure below. The output is verbatim from the command — trust it over any summary, including your own.",
    passed: result.passed,
    failures: result.failures,
  };
}
