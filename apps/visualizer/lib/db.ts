/**
 * Read the trace. The UI polls; nothing is pushed.
 *
 * `node:sqlite` opened READ-ONLY. The visualizer is a reader and must never be
 * able to corrupt a run's record — the single exception is archiving, which is
 * review triage that belongs to the reader rather than the run, and which is
 * why `archived` is the one column a tracer never writes.
 *
 * WAL means these reads never block a workflow that is mid-phase.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DB_PATH =
  process.env["SFO_DB"] ?? path.join(homedir(), ".sfo-build", "sfo.db");
export const SESSIONS_DIR =
  process.env["SFO_SESSIONS"] ?? path.join(homedir(), ".sfo-build", "sessions");

export class MissingDatabase extends Error {}

let readonlyDb: DatabaseSync | null = null;
let writableDb: DatabaseSync | null = null;

function open(readOnly: boolean): DatabaseSync {
  if (!existsSync(DB_PATH)) {
    throw new MissingDatabase(
      `no trace database at ${DB_PATH} — run a workflow first, e.g. ` +
        `npm run scout -- --target oms "what is this repo"`,
    );
  }
  const db = new DatabaseSync(DB_PATH, { readOnly });
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}

function reader(): DatabaseSync {
  readonlyDb ??= open(true);
  return readonlyDb;
}

function writer(): DatabaseSync {
  writableDb ??= open(false);
  return writableDb;
}

/**
 * `node:sqlite` hands back rows with a NULL prototype. They read fine on the
 * server and then die at the client boundary — React refuses to serialize
 * anything that is not a plain object — so every row is respread here, once,
 * rather than at each call site that happens to reach a component.
 */
function plain<T>(row: T): T {
  return { ...row };
}

function all<T>(sql: string, ...params: unknown[]): T[] {
  return (reader().prepare(sql).all(...(params as never[])) as T[]).map(plain);
}

function one<T>(sql: string, ...params: unknown[]): T | undefined {
  const row = reader().prepare(sql).get(...(params as never[])) as T | undefined;
  return row === undefined ? undefined : plain(row);
}

// ── row shapes (the db's own columns, not the engine's in-memory types) ──────

export interface SessionRow {
  adw_id: string;
  adw_name: string | null;
  request: string | null;
  status: string;
  engineer: string | null;
  target: string | null;
  repo_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number;
  premium_requests: number;
  nano_aiu: number;
  archived: number;
}

export interface PhaseRow {
  phase_id: string;
  adw_id: string;
  seq: number;
  name: string;
  kind: string;
  owner: string;
  description: string;
  status: string;
  attempt: number;
  retries: number;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface EventRow {
  rowid: number;
  event_id: string;
  phase_id: string | null;
  parent_id: string | null;
  type: string;
  name: string;
  payload_json: string;
  tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface EnvelopeRow {
  envelope_id: string;
  phase_id: string;
  agent: string;
  output_type: string;
  payload_json: string;
  valid: number;
  attempt: number;
  created_at: string;
}

export interface GateRow {
  id: number;
  phase_id: string;
  attempt: number;
  gate: string;
  passed: number;
  violations_json: string;
  checks_json: string;
  created_at: string;
}

export interface AgentSessionRow {
  agent: string;
  coding_agent: string;
  model: string;
  color: string;
  session_id: string;
  context_tokens: number;
  context_window: number;
  tools_json: string | null;
  last_used_at: string;
}

export interface ProcessRow {
  id: number;
  adw_id: string;
  kind: string;
  name: string;
  pid: number;
  command: string;
  started_at: string;
}

// ── queries ──────────────────────────────────────────────────────────────────

export function health() {
  const journal = one<{ journal_mode: string }>("PRAGMA journal_mode");
  const count = one<{ n: number }>("SELECT COUNT(*) AS n FROM sessions");
  return {
    ok: true,
    db: DB_PATH,
    journal_mode: journal?.journal_mode ?? "unknown",
    sessions: count?.n ?? 0,
  };
}

export function sessions(opts: { limit?: number; target?: string; archived?: boolean } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.target) {
    where.push("target = ?");
    params.push(opts.target);
  }
  if (opts.archived !== undefined) {
    where.push("COALESCE(archived, 0) = ?");
    params.push(opts.archived ? 1 : 0);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = all<SessionRow>(
    `SELECT * FROM sessions ${clause} ORDER BY started_at DESC LIMIT ?`,
    ...params,
    Math.min(Math.max(opts.limit ?? 200, 1), 500),
  );
  // One round trip for the phase tallies rather than N — the list view shows a
  // progress dot per phase and would otherwise fan out per session.
  const tallies = all<{ adw_id: string; status: string; n: number }>(
    "SELECT adw_id, status, COUNT(*) AS n FROM phases GROUP BY adw_id, status",
  );
  const byId = new Map<string, { total: number; success: number; fail: number; running: number }>();
  for (const t of tallies) {
    const entry = byId.get(t.adw_id) ?? { total: 0, success: 0, fail: 0, running: 0 };
    entry.total += t.n;
    if (t.status === "success") entry.success += t.n;
    else if (t.status === "running") entry.running += t.n;
    else entry.fail += t.n;
    byId.set(t.adw_id, entry);
  }
  return rows.map((row) => ({
    ...row,
    phases: byId.get(row.adw_id) ?? { total: 0, success: 0, fail: 0, running: 0 },
  }));
}

export function targets(): { target: string; runs: number }[] {
  return all<{ target: string; runs: number }>(
    `SELECT COALESCE(target, '') AS target, COUNT(*) AS runs FROM sessions
      GROUP BY target ORDER BY runs DESC`,
  ).filter((t) => t.target);
}

export function session(adwId: string): SessionRow | undefined {
  return one<SessionRow>("SELECT * FROM sessions WHERE adw_id = ?", adwId);
}

export function phases(adwId: string): PhaseRow[] {
  return all<PhaseRow>("SELECT * FROM phases WHERE adw_id = ? ORDER BY seq", adwId);
}

export function agentSessions(adwId: string): AgentSessionRow[] {
  return all<AgentSessionRow>(
    "SELECT * FROM agent_sessions WHERE adw_id = ? ORDER BY last_used_at",
    adwId,
  );
}

export function processes(adwId?: string): ProcessRow[] {
  return adwId
    ? all<ProcessRow>(
        "SELECT * FROM processes WHERE adw_id = ? AND ended_at IS NULL ORDER BY id DESC",
        adwId,
      )
    : all<ProcessRow>("SELECT * FROM processes WHERE ended_at IS NULL ORDER BY id DESC");
}

export function sessionDetail(adwId: string) {
  const row = session(adwId);
  if (!row) return null;
  return {
    session: row,
    phases: phases(adwId),
    agents: agentSessions(adwId),
    processes: processes(adwId),
  };
}

/**
 * Events after a cursor. `rowid` is the cursor rather than a timestamp: two
 * events inside the same millisecond are common, and insertion order is the
 * order that actually happened.
 */
export function events(adwId: string, after = 0, limit = 500): EventRow[] {
  return all<EventRow>(
    `SELECT rowid, event_id, phase_id, parent_id, type, name, payload_json,
            tokens, started_at, ended_at
       FROM events WHERE adw_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
    adwId,
    after,
    Math.min(Math.max(limit, 1), 2000),
  );
}

export function envelopes(adwId: string): EnvelopeRow[] {
  return all<EnvelopeRow>(
    "SELECT * FROM envelopes WHERE adw_id = ? ORDER BY created_at",
    adwId,
  );
}

export function gates(adwId: string): GateRow[] {
  return all<GateRow>("SELECT * FROM gate_results WHERE adw_id = ? ORDER BY id", adwId);
}

/** The one write. Triage belongs to the reader, so it touches nothing a run wrote. */
export function setArchived(adwId: string, archived: boolean): boolean {
  const db = writer();
  db.prepare("UPDATE sessions SET archived = ? WHERE adw_id = ?").run(archived ? 1 : 0, adwId);
  const row = db.prepare("SELECT adw_id FROM sessions WHERE adw_id = ?").get(adwId);
  return Boolean(row);
}

/** `..` and separators can never reach a path built from a URL segment. */
export function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}
