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

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * An artifact has to be somewhere the artifact is FOR.
 *
 * Existence alone is not enough, and this is not hypothetical: a documenter
 * whose writes into the repo and the session directory both failed fell back
 * to writing its report inside its own COPILOT_HOME, declared that path, and
 * passed both artifacts_exist and files_non_empty. The file was real, non-empty
 * and completely useless — nobody would ever read it, and the commit phase
 * afterwards had nothing to commit.
 *
 * Two roots are legitimate: the target repo (a work product that ships) and
 * this run's session directory (a handoff between agents). Anywhere else means
 * the agent did not do what it claimed, however well-formed the claim looks.
 */
function artifactLocation(run: RunLike, artifact: string): { ok: boolean; note: string } {
  const full = resolveArtifact(run, artifact);
  if (within(full, run.repoRoot)) return { ok: true, note: "" };
  if (within(full, run.sessionDir)) return { ok: true, note: "" };
  return {
    ok: false,
    note:
      `declared artifact is outside both the repo (${run.repoRoot}) and this ` +
      `run's session directory (${run.sessionDir}) — nothing reads that path`,
  };
}

function named<T extends EnvelopeBase>(name: string, gate: Gate<T>): Gate<T> {
  gate.gateName = name;
  return gate;
}

/** Every path the agent declared as an artifact must exist. */
export const artifacts_exist: Gate = named("artifacts_exist", (envelope, run) => {
  const report = new GateReport();
  if (!envelope.artifacts.length) {
    report.check("artifacts", false, "no artifacts declared — this phase is required to produce one");
    return report;
  }
  for (const artifact of envelope.artifacts) {
    const where = artifactLocation(run, artifact);
    if (!where.ok) {
      report.check(artifact, false, where.note);
      continue;
    }
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

/**
 * A named field must point at a file that exists IN THE REPO.
 *
 * `artifacts` may legitimately live in the session directory; a work product
 * that is supposed to ship — the documenter's write-up — may not. This is the
 * gate that would have caught the COPILOT_HOME fallback at the phase that
 * produced it rather than at the commit two phases later.
 */
export function file_in_repo(field: string): Gate {
  const gate: Gate = (envelope, run) => {
    const report = new GateReport();
    const claimed = String((envelope as Record<string, unknown>)[field] ?? "");
    if (!claimed) {
      report.check(field, false, `${field} is empty — name the file you wrote, relative to the repo root`);
      return report;
    }
    if (path.isAbsolute(claimed) && !within(claimed, run.repoRoot)) {
      report.check(claimed, false, `${field} must be inside the repo at ${run.repoRoot}`);
      return report;
    }
    const full = path.isAbsolute(claimed) ? claimed : path.join(run.repoRoot, claimed);
    const exists = existsSync(full) && statSync(full).isFile();
    report.check(
      claimed,
      exists,
      exists ? `exists in the repo, ${humanSize(statSync(full).size)}` : `${field} does not exist at ${full}`,
    );
    return report;
  };
  gate.gateName = `file_in_repo(${field})`;
  return gate;
}

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
      "the builder claims it changed nothing — a build phase that changed nothing has not built anything",
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

/**
 * Resolve a path against a NAMED target, not the phase's own.
 *
 * This is the whole trick behind cross-repo verification. An agent is sandboxed
 * into one checkout and can only claim what it saw there; the harness is not
 * sandboxed at all, so it can stat a path in a repo the claimant was never
 * allowed to open. The agent proposes a trail through three trees; code walks
 * it. An unregistered target is itself a violation — a hop into a repo this run
 * never resolved is a hop nobody can check.
 */
function resolveInTarget(
  run: RunLike,
  targetName: string,
  file: string,
): { ok: boolean; note: string } {
  const target = run.targets.find((t) => t.name === targetName);
  if (!target) {
    return {
      ok: false,
      note:
        `target '${targetName}' is not one this run resolved (${run.targets
          .map((t) => t.name)
          .join(", ")}) — nothing can check a path in a repo that was never opened`,
    };
  }
  const full = path.isAbsolute(file) ? file : path.join(target.path, file);
  if (!within(full, target.path)) {
    return { ok: false, note: `escapes ${targetName} at ${target.path}` };
  }
  const exists = existsSync(full);
  return {
    ok: exists,
    note: exists ? `exists in ${targetName}` : `does not exist at ${full}`,
  };
}

/**
 * Every hop names a real file in the repo it says it is in. The trace's contract.
 *
 * `findings_resolve` for a trail that crosses checkouts. The target is half the
 * claim: `src/checkout.ts` is true in one repo and a fabrication in another, and
 * a hop that does not say which is not a claim anyone can refute.
 */
export const hops_resolve: Gate = named("hops_resolve", (envelope, run) => {
  const report = new GateReport();
  const hops = (envelope as { hops?: { target: string; file: string }[] }).hops ?? [];
  if (!hops.length) {
    report.check("hops", false, "no hops reported — say the path is not there rather than returning an empty trail");
    return report;
  }
  for (const hop of hops) {
    const where = resolveInTarget(run, hop.target, hop.file);
    report.check(`${hop.target}:${hop.file}`, where.ok, where.note);
  }
  return report;
});

/**
 * Candidate fixes that hold together — and a document that agrees with them.
 *
 * Three checks, none of them about whether a fix is any GOOD; that is the
 * reader's call and no gate should pretend to it. What IS checkable: each
 * option lands in a repo this run knows, the files it names are really there,
 * and the write-up leads with the same option the envelope ranks first. That
 * last one matters because the ordering carries the recommendation — a document
 * that opens on option two is recommending something the envelope does not.
 */
export const options_sound: Gate = named("options_sound", (envelope, run) => {
  const report = new GateReport();
  const options =
    (envelope as { options?: { name: string; target: string; files?: string[] }[] }).options ?? [];
  if (!options.length) {
    report.check("options", false, "no options proposed");
    return report;
  }
  for (const option of options) {
    for (const file of option.files ?? []) {
      const where = resolveInTarget(run, option.target, file);
      report.check(`${option.name} → ${option.target}:${file}`, where.ok, where.note);
    }
  }

  // The recommendation is the ORDER, so the document has to open on it.
  const first = options[0]!;
  const doc = envelope.artifacts.find((a) => a.endsWith(".md"));
  if (!doc) {
    report.check("write-up", false, "no .md artifact declared — the options need somewhere to be read");
    return report;
  }
  const full = resolveArtifact(run, doc);
  if (!existsSync(full)) {
    report.check(doc, false, "declared write-up does not exist"); // artifacts_exist says more
    return report;
  }
  const heading = readFileSync(full, "utf8")
    .split("\n")
    .find((line) => line.startsWith("## "));
  const leads = Boolean(heading && heading.includes(first.name));
  report.check(
    `${doc} leads with '${first.name}'`,
    leads,
    leads
      ? "the write-up opens on the recommended option"
      : `options[0] is '${first.name}' but the write-up opens on '${(heading ?? "(no ## heading)").trim()}' — ` +
        `the order IS the recommendation, so these cannot disagree`,
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
