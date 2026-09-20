/**
 * Validation gates: verify the envelope's CLAIMS, never guesses.
 *
 * A gate is `gate(envelope, run) -> GateReport` — one check per item it looked
 * at. Violations are derived from the failed checks and sent back to the SAME
 * agent session as a correction. Every check is recorded either way, so a green
 * gate says WHAT it verified instead of only that it passed.
 *
 * Hard rule 3: gates validate claims AFTER the fact, never predictions. "Will
 * this work?" is not a gate. "You said you wrote this file — did you?" is.
 * Gates check what is mechanically checkable; plan quality is a reviewer's job.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { GateReport, type EnvelopeBase, type Gate, type RunLike } from "./types.ts";
import { humanSize } from "./utils.ts";

/**
 * Artifacts arrive in two flavours and both are legitimate: an absolute path
 * into the session handoff directory, or a repo-relative one like
 * `specs/x.md`. Relative paths resolve against the TARGET repo, which is the
 * only root an agent's paths can sensibly mean.
 */
function resolveArtifact(run: RunLike, artifact: string): string {
  return path.isAbsolute(artifact) ? artifact : path.join(run.repoRoot, artifact);
}

function named<T extends EnvelopeBase>(name: string, gate: Gate<T>): Gate<T> {
  gate.gateName = name;
  return gate;
}

/** Every path the agent declared as an artifact must exist. */
export const artifacts_exist: Gate = named("artifacts_exist", (envelope, run) => {
  const report = new GateReport();
  for (const artifact of envelope.artifacts) {
    const full = resolveArtifact(run, artifact);
    const exists = existsSync(full);
    report.check(
      artifact,
      exists,
      exists ? `exists, ${humanSize(statSync(full).size)}` : `declared artifact does not exist at ${full}`,
    );
  }
  return report;
});

/** A declared artifact that is an empty file is not an artifact. */
export const files_non_empty: Gate = named("files_non_empty", (envelope, run) => {
  const report = new GateReport();
  for (const artifact of envelope.artifacts) {
    const full = resolveArtifact(run, artifact);
    if (!existsSync(full) || !statSync(full).isFile()) continue; // artifacts_exist's job
    const size = statSync(full).size;
    report.check(artifact, size > 0, size === 0 ? "declared artifact is empty" : humanSize(size));
  }
  return report;
});

/** A declared `.json` artifact must actually parse. */
export const json_parses: Gate = named("json_parses", (envelope, run) => {
  const report = new GateReport();
  for (const artifact of envelope.artifacts) {
    if (path.extname(artifact) !== ".json") continue;
    const full = resolveArtifact(run, artifact);
    if (!existsSync(full)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(full, "utf8"));
      report.check(artifact, true, `parses, ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    } catch (error) {
      report.check(artifact, false, `declared JSON artifact does not parse: ${(error as Error).message}`);
    }
  }
  return report;
});

/**
 * Every file claimed changed must exist on disk.
 *
 * The cheap half of "did you do what you said". The expensive half — is the
 * change the RIGHT one — is the reviewer's, and no gate should pretend to it.
 */
export const diff_matches_claims: Gate = named("diff_matches_claims", (envelope, run) => {
  const report = new GateReport();
  const claimed = (envelope as { changed_files?: string[] }).changed_files ?? [];
  for (const file of claimed) {
    const full = resolveArtifact(run, file);
    const exists = existsSync(full);
    report.check(
      file,
      exists,
      exists ? `exists, ${humanSize(statSync(full).size)}` : "claimed changed file does not exist",
    );
  }
  if (!claimed.length) {
    report.check(
      "changed_files",
      false,
      "the builder reported no changed files — a build phase that changed nothing has not built anything",
    );
  }
  return report;
});

/**
 * A review's verdict must agree with the findings it just wrote down.
 *
 * Nothing here judges the code — that is the reviewer's job. This checks the
 * envelope against ITSELF: an approval that ships blocking items, or a
 * rejection that names no problem, is a claim the harness can refute without
 * reading a line of the diff.
 */
export const verdict_consistent: Gate = named("verdict_consistent", (envelope) => {
  const report = new GateReport();
  const review = envelope as {
    approved?: boolean;
    blocking?: string[];
    findings?: { requirement: string; met: boolean }[];
  };
  const approved = Boolean(review.approved);
  const blocking = review.blocking ?? [];
  const unmet = (review.findings ?? []).filter((f) => !f.met).map((f) => f.requirement);

  report.check(
    "approved vs blocking",
    !(approved && blocking.length),
    !blocking.length
      ? "no blocking items"
      : approved
        ? `${blocking.length} blocking item(s) while approved=true`
        : `${blocking.length} blocking item(s), not approved`,
  );
  report.check(
    "approved vs findings",
    !(approved && unmet.length),
    !unmet.length
      ? "every requirement met"
      : approved
        ? `${unmet.length} unmet requirement(s) while approved=true`
        : `${unmet.length} unmet requirement(s), not approved`,
  );
  report.check(
    "rejection names a problem",
    approved || blocking.length > 0 || unmet.length > 0,
    approved || blocking.length || unmet.length
      ? "verdict is supported"
      : "approved=false but no blocking item or unmet requirement was given",
  );
  return report;
});

/** At least one finding, each naming a file that exists. Scout's contract. */
export const findings_resolve: Gate = named("findings_resolve", (envelope, run) => {
  const report = new GateReport();
  const findings = (envelope as { findings?: { file: string; note: string }[] }).findings ?? [];
  if (!findings.length) {
    report.check("findings", false, "no findings reported — say so explicitly rather than returning an empty list");
    return report;
  }
  for (const finding of findings) {
    const full = resolveArtifact(run, finding.file);
    const exists = existsSync(full);
    report.check(finding.file, exists, exists ? "path exists" : "finding cites a path that does not exist");
  }
  return report;
});
