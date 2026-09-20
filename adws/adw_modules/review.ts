/**
 * Two judges on one clock, and the one envelope the builder revises against.
 *
 * The reviewer asks "is this what was asked for". The adversary asks "what does
 * this do that nobody asked for". They run CONCURRENTLY and on different
 * vendors, which is the whole point: a second opinion that has already read the
 * first one is not a second opinion, and sequentially the adversary would find
 * `review.md` sitting in a handoff directory it is given by `--add-dir`.
 *
 * Concurrency is bounded and deliberate — exactly two agent phases, both
 * read-only, both standing in the same checkout. Everything that made that
 * unsafe has been fixed where it lived rather than worked around here: phase
 * lanes in console.ts, the open-phase set in runner.ts, `--no-optional-locks`
 * in permissions.ts and in both prompts.
 */

import * as gates from "./gates.ts";
import type { Run } from "./runner.ts";
import { ReviewOutput, type EnvelopeBase, type ReviewFinding } from "./types.ts";

/** Both judges answer to the same two gates. */
const REVIEW_GATES = [gates.artifacts_exist, gates.verdict_consistent];

export interface Verdicts {
  review: ReviewOutput;
  /** `null` when the run did not ask for a second judge. */
  adversary: ReviewOutput | null;
}

async function judge(params: {
  run: Run;
  name: string;
  owner: string;
  description: string;
  prompt: string;
  previous: EnvelopeBase;
}): Promise<ReviewOutput> {
  await using ph = params.run.phase({
    name: params.name,
    kind: "agent",
    owner: params.owner,
    description: params.description,
    retries: 1,
  });
  const verdict = await ph.call({
    outputType: ReviewOutput,
    outputTypeName: "ReviewOutput",
    prompt: params.prompt,
    previous: params.previous,
    gates: REVIEW_GATES,
  });
  ph.done();
  return verdict;
}

/**
 * Run the judges for one revision round.
 *
 * `allSettled`, never `all`. `all` rejects the moment the first judge throws a
 * gate failure, abandoning the other mid-flight: its copilot child keeps
 * running, its disposer is never reached, and the trace keeps a phase row
 * reading `running` for a phase nobody is waiting on. Settling both first costs
 * the remainder of one agent's turn and leaves the trace honest.
 */
export async function reviewRound(params: {
  run: Run;
  round: number;
  prompt: string;
  build: EnvelopeBase;
  /** Opt-in. False reproduces the single-reviewer chain exactly. */
  adversarial: boolean;
}): Promise<Verdicts> {
  const { run, round, prompt, build } = params;
  const reviewPhase = judge({
    run,
    name: `review_${round}`,
    owner: "reviewer",
    description: "Rule on every requirement in the spec, against the code on disk",
    prompt,
    previous: build,
  });

  if (!params.adversarial) return { review: await reviewPhase, adversary: null };

  const settled = await Promise.allSettled([
    reviewPhase,
    judge({
      run,
      name: `adversary_${round}`,
      owner: "adversary",
      description: "Hunt for what this change does that nobody asked for",
      prompt,
      previous: build,
    }),
  ]);

  // Both phases have closed by now. Only after that does a failure escape.
  for (const outcome of settled) {
    if (outcome.status === "rejected") throw outcome.reason;
  }
  const [review, adversary] = settled as PromiseFulfilledResult<ReviewOutput>[];
  return { review: review!.value, adversary: adversary!.value };
}

/** Whose finding this was. The builder is owed the provenance. */
function attribute(findings: ReviewFinding[], who: string): ReviewFinding[] {
  return findings.map((f) => ({
    ...f,
    evidence: f.evidence ? `${who}: ${f.evidence}` : who,
  }));
}

/**
 * One envelope for the builder to revise against.
 *
 * INPUT ONLY — this is never handed to a gate. It is still kept internally
 * consistent (`approved` false whenever anything is blocking), because an
 * envelope that contradicts itself is exactly what `verdict_consistent` exists
 * to refuse and there is no reason to hand the builder one.
 *
 * What this does NOT do is decide the run. The commit criterion reads the
 * reviewer's own `approved`, which is what keeps the adversary advisory: it can
 * spend a revision loop, it can never hold the chain shut.
 */
export function mergeReviews(review: ReviewOutput, adversary: ReviewOutput | null): ReviewOutput {
  if (!adversary) return review;

  const blocking = [...new Set([...review.blocking, ...adversary.blocking.map((b) => `[adversary] ${b}`)])];
  const findings = [
    ...attribute(review.findings, "reviewer"),
    ...attribute(adversary.findings, "adversary"),
  ];
  return {
    status: review.status === "success" && adversary.status === "success" ? "success" : "fail",
    summary:
      `reviewer ${review.approved ? "approved" : "rejected"}: ${review.summary} · ` +
      `adversary ${adversary.approved ? "approved" : "rejected"}: ${adversary.summary}`,
    artifacts: [...new Set([...review.artifacts, ...adversary.artifacts])],
    notes_for_next_agent: [review.notes_for_next_agent, adversary.notes_for_next_agent]
      .filter(Boolean)
      .join(" · "),
    approved: review.approved && adversary.approved && blocking.length === 0,
    findings,
    blocking,
  };
}
