#!/usr/bin/env bun
/**
 * Read the trace from the terminal. Shipped in P1, not P5 — a factory you
 * cannot observe is one you debug by reading raw JSONL, and the visualizer is
 * the LAST thing built, not the first.
 *
 *   npm run sessions
 *   npm run phases -- <adw_id>
 *   npm run tail   -- <adw_id> [--type tool_call] [--limit 80]
 *   npm run procs
 */

import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "./adw_modules/config.ts";
import { configPath } from "./adw_modules/session.ts";
import { clip, expandHome } from "./adw_modules/utils.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

function mark(status: string): string {
  if (status === "success") return `${GREEN}✓${RESET}`;
  if (status === "running") return `${YELLOW}▸${RESET}`;
  return `${RED}✗${RESET}`;
}

function open(): DatabaseSync {
  const cfg = loadConfig(configPath());
  return new DatabaseSync(expandHome(cfg.observability.db), { readOnly: true });
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function sessions(db: DatabaseSync, limit: number): void {
  const rows = db
    .prepare(
      `SELECT adw_id, adw_name, status, target, engineer, request, started_at,
              premium_requests, nano_aiu
         FROM sessions ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as Record<string, string | number | null>[];
  if (!rows.length) {
    process.stdout.write("no sessions yet\n");
    return;
  }
  process.stdout.write(
    `${BOLD}${"adw_id".padEnd(10)}${"target".padEnd(8)}${"status".padEnd(9)}` +
      `${"prem".padEnd(6)}${"when".padEnd(11)}what${RESET}\n`,
  );
  for (const row of rows) {
    const status = String(row["status"] ?? "");
    process.stdout.write(
      `${String(row["adw_id"]).padEnd(10)}${String(row["target"] ?? "").padEnd(8)}` +
        `${mark(status)} ${status.padEnd(7)}${String(row["premium_requests"] ?? 0).padEnd(6)}` +
        `${ago(row["started_at"] as string).padEnd(11)}` +
        `${DIM}${String(row["adw_name"] ?? "")}${RESET} ` +
        `${clip(String(row["request"] ?? ""), 60)}\n`,
    );
  }
}

function phases(db: DatabaseSync, adwId: string): void {
  const session = db
    .prepare("SELECT * FROM sessions WHERE adw_id = ?")
    .get(adwId) as Record<string, string | number | null> | undefined;
  if (!session) {
    process.stdout.write(`no session ${adwId}\n`);
    return;
  }
  process.stdout.write(
    `${BOLD}${adwId}${RESET} ${session["adw_name"] ?? ""} · target ${session["target"]} · ` +
      `${mark(String(session["status"]))} ${session["status"]}\n` +
      `${DIM}${session["repo_path"]}${RESET}\n` +
      `${DIM}${clip(String(session["request"] ?? ""), 140)}${RESET}\n\n`,
  );
  const rows = db
    .prepare(
      `SELECT seq, name, kind, owner, status, attempt, retries, error, started_at, ended_at
         FROM phases WHERE adw_id = ? ORDER BY seq`,
    )
    .all(adwId) as Record<string, string | number | null>[];
  for (const row of rows) {
    const started = row["started_at"] ? Date.parse(row["started_at"] as string) : 0;
    const ended = row["ended_at"] ? Date.parse(row["ended_at"] as string) : 0;
    const seconds = started && ended ? `${((ended - started) / 1000).toFixed(1)}s` : "";
    process.stdout.write(
      `${mark(String(row["status"]))} ${String(row["seq"]).padStart(2, "0")} ` +
        `${String(row["name"]).padEnd(14)}${DIM}${String(row["kind"]).padEnd(9)}` +
        `${String(row["owner"]).padEnd(12)}${seconds.padStart(7)}${RESET}\n`,
    );
    if (row["error"]) process.stdout.write(`      ${RED}${clip(String(row["error"]), 200)}${RESET}\n`);
  }
  const gates = db
    .prepare(
      `SELECT gate, passed, COUNT(*) AS n FROM gate_results WHERE adw_id = ? GROUP BY gate, passed`,
    )
    .all(adwId) as Record<string, string | number>[];
  if (gates.length) {
    process.stdout.write(`\n${BOLD}gates${RESET}\n`);
    for (const g of gates) {
      process.stdout.write(
        `  ${Number(g["passed"]) ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${g["gate"]} ×${g["n"]}\n`,
      );
    }
  }
  process.stdout.write(
    `\n${DIM}premium requests ${session["premium_requests"] ?? 0} · ` +
      `nanoAIU ${session["nano_aiu"] ?? 0}${RESET}\n`,
  );
}

function tail(db: DatabaseSync, adwId: string, type: string | null, limit: number): void {
  const rows = (
    type
      ? db
          .prepare(
            `SELECT type, name, payload_json, started_at FROM events
              WHERE adw_id = ? AND type = ? ORDER BY rowid DESC LIMIT ?`,
          )
          .all(adwId, type, limit)
      : db
          .prepare(
            `SELECT type, name, payload_json, started_at FROM events
              WHERE adw_id = ? ORDER BY rowid DESC LIMIT ?`,
          )
          .all(adwId, limit)
  ) as Record<string, string>[];
  for (const row of rows.reverse()) {
    const kind = String(row["type"]);
    const colour = kind === "error" || kind === "gate_fail" ? RED : kind === "gate_pass" ? GREEN : DIM;
    let detail = "";
    if (kind === "log") {
      try {
        detail = String((JSON.parse(row["payload_json"] ?? "{}") as { message?: string }).message ?? "");
      } catch {
        detail = "";
      }
    }
    process.stdout.write(
      `${DIM}${String(row["started_at"] ?? "").slice(11, 23)}${RESET} ` +
        `${colour}${kind.padEnd(12)}${RESET}${clip(detail || String(row["name"] ?? ""), 120)}\n`,
    );
  }
}

function procs(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT adw_id, kind, name, pid, command, started_at FROM processes
        WHERE ended_at IS NULL ORDER BY id DESC`,
    )
    .all() as Record<string, string | number>[];
  if (!rows.length) {
    process.stdout.write("nothing believed alive\n");
    return;
  }
  process.stdout.write(`${BOLD}${"pid".padEnd(8)}${"adw_id".padEnd(10)}${"kind".padEnd(7)}what${RESET}\n`);
  for (const row of rows) {
    // A row is only "believed" alive — a -9'd run never got to close it.
    let alive = true;
    try {
      process.kill(Number(row["pid"]), 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code === "EPERM";
    }
    process.stdout.write(
      `${String(row["pid"]).padEnd(8)}${String(row["adw_id"]).padEnd(10)}` +
        `${String(row["kind"]).padEnd(7)}${clip(String(row["command"]), 70)}` +
        `${alive ? "" : `  ${DIM}(stale row — process is gone)${RESET}`}\n`,
    );
  }
}

const [command, ...rest] = process.argv.slice(2);
const flagIndex = rest.findIndex((a) => a.startsWith("--"));
const positional = flagIndex === -1 ? rest : rest.slice(0, flagIndex);
const flag = (name: string): string | null => {
  const i = rest.indexOf(`--${name}`);
  return i !== -1 && rest[i + 1] ? rest[i + 1]! : null;
};

const db = open();
try {
  if (command === "sessions") sessions(db, Number(flag("limit") ?? 20));
  else if (command === "phases") {
    if (!positional[0]) throw new Error("usage: npm run phases -- <adw_id>");
    phases(db, positional[0]);
  } else if (command === "tail") {
    if (!positional[0]) throw new Error("usage: npm run tail -- <adw_id> [--type tool_call]");
    tail(db, positional[0], flag("type"), Number(flag("limit") ?? 60));
  } else if (command === "procs") procs(db);
  else {
    process.stderr.write("usage: adw_observe.ts sessions | phases <id> | tail <id> | procs\n");
    process.exit(2);
  }
} finally {
  db.close();
}
