/**
 * Console reporter: one narrative, two destinations.
 *
 * Every line an ADW prints ALSO lands in the db as a `log` event, so the
 * swim-lane UI reads the same story the terminal does. Both go through `emit`
 * — print and trace cannot drift. Plain sequential lines only: no spinners, no
 * live displays, so a CI log reads exactly like a terminal.
 */

import type { EnvelopeBase, GateReport, Phase, UsageBreakdown } from "./types.ts";
import { aiCredits, money } from "./types.ts";
import { clip } from "./utils.ts";

const MAX_LINE = 160; // dynamic text (summaries, violations, errors) is clipped

const useColor =
  process.stdout.isTTY && process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb";

type Style =
  | "reset" | "bold" | "dim" | "red" | "green" | "yellow" | "blue"
  | "magenta" | "cyan" | "white";

const CODES: Record<Style, string> = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m",
  green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m",
  cyan: "\x1b[36m", white: "\x1b[37m",
};

function paint(text: string, ...styles: Style[]): string {
  if (!useColor || !styles.length) return text;
  return `${styles.map((s) => CODES[s]).join("")}${text}${CODES.reset}`;
}

const KIND_COLOR: Record<string, Style> = {
  engineer: "cyan",
  agent: "magenta",
  code: "yellow",
};

interface TracerLike {
  event(record: {
    adw_id: string;
    phase_id?: string;
    type: string;
    name?: string;
    payload?: Record<string, unknown>;
  }): string;
}

/** Bound to one run's tracer. Reachable as `run.console` everywhere. */
export class Console {
  private phaseId = ""; // current lane — log events attach to it
  private phaseName = "";
  readonly results: string[] = []; // phase statuses, for the summary
  private finished = false; // the summary block prints once

  constructor(
    private readonly tracer: TracerLike,
    private readonly adwId: string,
  ) {}

  /** The one helper: print AND trace, always together. */
  private emit(line: string, plain: string, level: "info" | "warn" | "error" = "info"): void {
    process.stdout.write(`${line}\n`);
    this.tracer.event({
      adw_id: this.adwId,
      phase_id: this.phaseId,
      type: "log",
      name: this.phaseName || "console",
      payload: { message: plain, level },
    });
  }

  // ── session ────────────────────────────────────────────────────────────────
  sessionStarted(adwId: string, engineer: string, target: string, repoPath: string): void {
    this.emit(
      `${paint("adw_id:", "bold", "cyan")} ${paint(adwId, "bold")}   ` +
        `${paint("target", "dim")} ${target}   ${paint("engineer", "dim")} ${engineer}\n` +
        `${paint("  repo:", "dim")} ${paint(repoPath, "dim")}`,
      `session ${adwId} · target ${target} · repo ${repoPath} · engineer ${engineer}`,
    );
  }

  sessionFinished(ok: boolean, usage: UsageBreakdown, dbPath: string): void {
    if (this.finished) return;
    this.finished = true;
    const passed = this.results.filter((r) => r === "success").length;
    const status = ok ? paint("✓ success", "green") : paint("✗ fail", "red");
    const rows = [
      ` ${paint("status", "dim")}   ${status}`,
      ` ${paint("phases", "dim")}   ${passed}/${this.results.length} passed`,
      ` ${paint("prompt", "dim")}   ${usage.prompt_tokens.toLocaleString()} tokens (last turn occupancy)`,
      ` ${paint("cost", "dim")}     ${paint(money(usage.nano_aiu), "bold")} est. ${paint(`(${aiCredits(usage.nano_aiu).toFixed(2)} AI credits @ $0.01)`, "dim")}`,
      ` ${paint("premium", "dim")}  ${usage.premium_requests.toLocaleString()} requests`,
      ` ${paint("adw_id", "dim")}   ${this.adwId}`,
      ` ${paint("db", "dim")}       ${dbPath}`,
      ` ${paint("next", "dim")}     ${paint(`npm run phases -- ${this.adwId}`, "bold")}`,
    ];
    const border = ok ? paint("─".repeat(60), "green") : paint("─".repeat(60), "red");
    const title = paint("ADW complete", "bold");
    const plain =
      `session ${this.adwId} ${ok ? "success" : "fail"} · ${passed}/${this.results.length} phases · ` +
      `${money(usage.nano_aiu)} est. · ${usage.premium_requests} premium requests · ${usage.nano_aiu} nanoAIU`;
    this.emit(`${border}\n ${title}\n${rows.join("\n")}\n${border}`, plain, ok ? "info" : "error");
  }

  // ── phases ─────────────────────────────────────────────────────────────────
  phaseStarted(phase: Phase): void {
    this.phaseId = phase.phase_id;
    this.phaseName = phase.params.name;
    const p = phase.params;
    const color = KIND_COLOR[p.kind] ?? "white";
    const seq = String(phase.seq).padStart(2, "0");
    let line = `${paint(`▶ ${seq} ${p.name}`, "bold", color)}  ${paint(p.kind, color)} ${paint(`· ${p.owner}`, "dim")}`;
    if (p.description) line += `  ${paint(clip(p.description, MAX_LINE), "dim")}`;
    this.emit(line, `phase ${seq} ${p.name} (${p.kind}, ${p.owner}) — ${p.description}`);
  }

  phaseEnded(phase: Phase, seconds: number): void {
    const ok = phase.status === "success";
    this.results.push(phase.status);
    let line = `  ${ok ? paint("✓", "green") : paint("✗", "red")} ${phase.params.name} ${paint(`${seconds.toFixed(1)}s`, "dim")}`;
    let plain = `${phase.params.name} ${phase.status} ${seconds.toFixed(1)}s`;
    if (!ok && phase.error) {
      line += `  ${paint(clip(phase.error, MAX_LINE), "red")}`;
      plain += ` — ${clip(phase.error, MAX_LINE)}`;
    }
    this.emit(line, plain, ok ? "info" : "error");
    this.phaseId = "";
    this.phaseName = "";
  }

  /** Free-form detail inside the current phase — what `ph.log()` recorded. */
  note(message: string): void {
    const text = clip(message, MAX_LINE);
    this.emit(`  ${paint(`· ${text}`, "dim")}`, text);
  }

  // ── agents ─────────────────────────────────────────────────────────────────
  agentStarted(name: string, model: string, sessionId: string): void {
    this.emit(
      `  ${paint("▸", "magenta")} ${name} ${paint(model, "dim")}  ${paint(`session ${sessionId}`, "dim")}`,
      `agent ${name} started · ${model} · session ${sessionId}`,
    );
  }

  agentFinished(name: string, usage: UsageBreakdown): void {
    const text =
      `${name} used ${money(usage.nano_aiu)} est. · ` +
      `${usage.premium_requests} premium request(s) · ` +
      `${usage.prompt_tokens.toLocaleString()} prompt tokens`;
    this.emit(`  ${paint(`└ ${text}`, "dim")}`, text);
  }

  toolCall(agent: string, label: string, ok: boolean, ms?: number): void {
    const mark = ok ? "·" : "✗";
    const time = ms === undefined ? "" : ` ${(ms / 1000).toFixed(1)}s`;
    const text = `${agent} ${label}${time}`;
    this.emit(
      `    ${paint(`${mark} ${clip(text, MAX_LINE)}`, ok ? "dim" : "red")}`,
      text,
      ok ? "info" : "error",
    );
  }

  retry(name: string, attempt: number, limit: number, reason: string): void {
    const text = `${name} retry ${attempt}/${limit} — same session · ${clip(reason, MAX_LINE)}`;
    this.emit(`  ${paint("⟳", "yellow")} ${text}`, text, "warn");
  }

  // ── verification ───────────────────────────────────────────────────────────
  /** A gate reports WHAT it checked, not just whether it passed. */
  gateResult(name: string, report: GateReport): void {
    const ok = report.passed;
    const mark = ok ? paint("✓", "green") : paint("✗", "red");
    const summary = ok
      ? `${report.checks.length} checked`
      : paint(`${report.violations.length} of ${report.checks.length} failed`, "red");
    this.emit(
      `  ${mark} gate ${paint(name, "dim")} ${summary}`,
      `gate ${name} ${ok ? "passed" : "failed"} (${report.checks.length} checks)`,
      ok ? "info" : "error",
    );
    for (const check of report.checks) {
      const detail = check.note ? ` — ${clip(check.note, MAX_LINE)}` : "";
      const body = `${check.ok ? "·" : "✗"} ${clip(check.item, MAX_LINE)}${detail}`;
      this.emit(
        `    ${check.ok ? paint(body, "dim") : paint(body, "dim", "red")}`,
        body,
        check.ok ? "info" : "error",
      );
    }
  }

  envelopeSummary(typeName: string, envelope: EnvelopeBase): void {
    const ok = envelope.status === "success";
    this.emit(
      `  ${ok ? paint("✓", "green") : paint("✗", "red")} ${typeName} ${paint(clip(envelope.summary, MAX_LINE), "dim")}`,
      `${typeName}: ${clip(envelope.summary, MAX_LINE)}`,
      ok ? "info" : "error",
    );
    if (envelope.artifacts.length) {
      const text = `artifacts: ${clip(envelope.artifacts.join(", "), MAX_LINE)}`;
      this.emit(`    ${paint(text, "dim")}`, text);
    }
  }
}
