/**
 * Every event lands in JSONL and SQLite AS IT HAPPENS.
 *
 * Files are the raw record; sfo.db is the queryable mirror the UI polls. No
 * push transport — the flow is always: agents -> sqlite -> web ui. WAL mode so
 * the UI can read while ADW processes write.
 *
 * `node:sqlite` rather than better-sqlite3: verified byte-identical on Node
 * 23.11.0 and Bun 1.4.2, zero dependencies, no native build step. Node prints
 * an ExperimentalWarning, which the npm scripts silence with
 * NODE_OPTIONS=--no-warnings.
 *
 * Cost is TWO columns, not one. Copilot reports no dollars anywhere (known
 * impossibility 3), so SSSF's `total_cost REAL` would be a fabrication with a
 * decimal point. `premium_requests` and `nano_aiu` are what the stream
 * actually says.
 */

import { DatabaseSync } from "node:sqlite";
import { appendFileSync } from "node:fs";
import path from "node:path";

import type {
  AgentConfig,
  EventRecord,
  GateReport,
  Phase,
  UsageBreakdown,
} from "./types.ts";
import { ensureDir, newId, nowIso } from "./utils.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  adw_id        TEXT PRIMARY KEY,
  adw_name      TEXT,                -- ADW script(s) run, e.g. "adw_plan + adw_build"
  request       TEXT,
  status        TEXT,
  engineer      TEXT,
  target        TEXT,                -- which registry row this run drove
  repo_path     TEXT,                -- the resolved checkout, so two targets sharing
                                     -- one tree are visible as such in the trace
  started_at    TEXT, ended_at TEXT,
  total_tokens      INTEGER DEFAULT 0,
  premium_requests  INTEGER DEFAULT 0,
  nano_aiu          INTEGER DEFAULT 0,
  archived      INTEGER DEFAULT 0    -- review triage, set by the UI; never by a run
);
CREATE TABLE IF NOT EXISTS phases (
  phase_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  seq           INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status        TEXT DEFAULT 'fail',
  attempt       INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
  error         TEXT,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  parent_id     TEXT,                -- Copilot's own parentId: a native span tree
  type          TEXT,
  name          TEXT,
  payload_json  TEXT,
  tokens        INTEGER,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id   TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  agent         TEXT,
  output_type   TEXT,
  payload_json  TEXT,
  valid         INTEGER,
  attempt       INTEGER,
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS gate_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  attempt       INTEGER,
  gate          TEXT,
  passed        INTEGER,
  violations_json TEXT,
  checks_json   TEXT,                -- [{item, ok, note}] — WHAT the gate verified
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS processes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  kind          TEXT,                -- 'adw' (the workflow) | 'agent' (a CLI child)
  name          TEXT,                -- '' for the adw, the agent name for a child
  pid           INTEGER,
  command       TEXT,                -- what the pid was, so a recycled pid is safe
  started_at    TEXT, ended_at TEXT  -- ended_at NULL = believed alive
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  adw_id        TEXT REFERENCES sessions,
  agent         TEXT,
  coding_agent  TEXT, model TEXT, color TEXT,
  session_id    TEXT,
  context_tokens INTEGER,            -- window occupancy after the agent's last turn
  context_window INTEGER,            -- 0/NULL = unknown; always 0 for Copilot
  tools_json    TEXT,                -- what the model was ACTUALLY offered
  created_at    TEXT, last_used_at TEXT,
  PRIMARY KEY (adw_id, agent)
);
CREATE INDEX IF NOT EXISTS idx_events_adw   ON events (adw_id, event_id);
CREATE INDEX IF NOT EXISTS idx_events_phase ON events (phase_id);
CREATE INDEX IF NOT EXISTS idx_phases_adw   ON phases (adw_id, seq);
`;

/**
 * Columns added after a schema shipped. CREATE TABLE IF NOT EXISTS never
 * revisits an existing table, so additive changes need an explicit ALTER.
 */
const MIGRATIONS: [string, string, string][] = [
  ["sessions", "target", "TEXT"],
  ["sessions", "repo_path", "TEXT"],
  ["sessions", "premium_requests", "INTEGER DEFAULT 0"],
  ["sessions", "nano_aiu", "INTEGER DEFAULT 0"],
  ["agent_sessions", "tools_json", "TEXT"],
];

export class Tracer {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly eventsJsonl: string;

  constructor(dbPath: string, eventsJsonl: string) {
    ensureDir(path.dirname(dbPath));
    ensureDir(path.dirname(eventsJsonl));
    this.dbPath = dbPath;
    this.eventsJsonl = eventsJsonl;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    for (const [table, column, decl] of MIGRATIONS) {
      const columns = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name);
      if (!columns.includes(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ── events ─────────────────────────────────────────────────────────────────
  event(record: EventRecord): string {
    const eventId = `evt_${newId(12)}`;
    const ts = nowIso();
    appendFileSync(this.eventsJsonl, `${JSON.stringify({ event_id: eventId, ts, ...record })}\n`);
    this.db
      .prepare(
        `INSERT INTO events (event_id, adw_id, phase_id, parent_id, type, name,
           payload_json, tokens, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        record.adw_id,
        // NULL, not "": a session-scoped event (the opening banner, a kill
        // notice) genuinely belongs to no phase, and node:sqlite enforces
        // foreign keys by default where Python's sqlite3 does not. "" is not a
        // phase_id anyone ever inserted, so it fails the constraint; NULL is
        // the honest value and FKs permit it.
        record.phase_id || null,
        record.parent_id ?? "",
        record.type,
        record.name ?? "",
        JSON.stringify(record.payload ?? {}),
        record.tokens ?? null,
        record.started_at ?? ts,
        record.ended_at ?? null,
      );
    return eventId;
  }

  // ── sessions ───────────────────────────────────────────────────────────────
  sessionStart(params: {
    adwId: string;
    engineer: string;
    adwName?: string;
    target?: string;
    repoPath?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (adw_id, status, engineer, target, repo_path, started_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(adw_id) DO UPDATE SET status='running'`,
      )
      .run(
        params.adwId,
        "running",
        params.engineer,
        params.target ?? "",
        params.repoPath ?? "",
        nowIso(),
      );
    if (!params.adwName) return;
    // A joined session chains ADWs — record each distinct one, in run order.
    const row = this.db
      .prepare("SELECT adw_name FROM sessions WHERE adw_id=?")
      .get(params.adwId) as { adw_name: string | null } | undefined;
    const names = row?.adw_name ? row.adw_name.split(" + ") : [];
    if (!names.includes(params.adwName)) {
      names.push(params.adwName);
      this.db
        .prepare("UPDATE sessions SET adw_name=? WHERE adw_id=?")
        .run(names.join(" + "), params.adwId);
    }
  }

  sessionRequest(adwId: string, request: string): void {
    this.db
      .prepare("UPDATE sessions SET request=? WHERE adw_id=?")
      .run(request.slice(0, 500), adwId);
  }

  sessionFinish(adwId: string, ok: boolean): void {
    this.db
      .prepare("UPDATE sessions SET status=?, ended_at=? WHERE adw_id=?")
      .run(ok ? "success" : "fail", nowIso(), adwId);
    this.processesEndAll(adwId); // nothing of this run is alive any more
  }

  sessionAddUsage(adwId: string, usage: UsageBreakdown): void {
    this.db
      .prepare(
        `UPDATE sessions SET total_tokens = total_tokens + ?,
           premium_requests = premium_requests + ?,
           nano_aiu = nano_aiu + ? WHERE adw_id=?`,
      )
      .run(usage.prompt_tokens, usage.premium_requests, usage.nano_aiu, adwId);
  }

  // ── processes (adw_id -> pid, so a hung run can be found and killed) ───────
  processStart(adwId: string, kind: string, name: string, pid: number, command: string): void {
    this.db
      .prepare(
        `INSERT INTO processes (adw_id, kind, name, pid, command, started_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(adwId, kind, name, pid, command.slice(0, 500), nowIso());
  }

  processEnd(adwId: string, pid: number): void {
    this.db
      .prepare(
        `UPDATE processes SET ended_at=? WHERE id = (
           SELECT id FROM processes WHERE adw_id=? AND pid=? AND ended_at IS NULL
           ORDER BY id DESC LIMIT 1)`,
      )
      .run(nowIso(), adwId, pid);
  }

  processesEndAll(adwId: string): void {
    this.db
      .prepare("UPDATE processes SET ended_at=? WHERE adw_id=? AND ended_at IS NULL")
      .run(nowIso(), adwId);
  }

  // ── phases ─────────────────────────────────────────────────────────────────
  /**
   * Highest seq already recorded for this session; 0 when it is new.
   *
   * A joined run continues the sequence instead of restarting at 1 — which
   * would collide with the first run's phases on both `seq` (breaking
   * ordering) and `phase_id` (silently overwriting a row through the upsert).
   */
  maxPhaseSeq(adwId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS m FROM phases WHERE adw_id = ?")
      .get(adwId) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  phaseUpsert(phase: Phase): void {
    const p = phase.params;
    this.db
      .prepare(
        `INSERT INTO phases (phase_id, adw_id, seq, name, kind, owner, description,
           status, attempt, retries, error, started_at, ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(phase_id) DO UPDATE SET status=excluded.status,
           attempt=excluded.attempt, error=excluded.error, ended_at=excluded.ended_at`,
      )
      .run(
        phase.phase_id,
        phase.adw_id,
        phase.seq,
        p.name,
        p.kind,
        p.owner,
        p.description,
        phase.status,
        phase.attempt,
        p.retries,
        phase.error ?? null,
        phase.started_at ?? null,
        phase.ended_at ?? null,
      );
  }

  // ── envelopes / gates / agent sessions ────────────────────────────────────
  envelopeRow(
    phase: Phase,
    agent: string,
    outputType: string,
    payloadJson: string,
    valid: boolean,
    attempt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO envelopes (envelope_id, adw_id, phase_id, agent, output_type,
           payload_json, valid, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `env_${newId(12)}`,
        phase.adw_id,
        phase.phase_id,
        agent,
        outputType,
        payloadJson,
        valid ? 1 : 0,
        attempt,
        nowIso(),
      );
  }

  /** The report carries both the verdict and the evidence behind it. */
  gateRow(phase: Phase, gate: string, report: GateReport, attempt: number): void {
    this.db
      .prepare(
        `INSERT INTO gate_results (adw_id, phase_id, attempt, gate, passed,
           violations_json, checks_json, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        phase.adw_id,
        phase.phase_id,
        attempt,
        gate,
        report.passed ? 1 : 0,
        JSON.stringify(report.violations),
        JSON.stringify(report.checks),
        nowIso(),
      );
  }

  /**
   * The agent's config row is the source of truth for its label and colour.
   *
   * Context is carried here rather than derived from events because the lane
   * wants one number per agent — the latest — and a session that runs the same
   * agent twice overwrites it, exactly like model and session_id.
   */
  agentSessionRow(params: {
    adwId: string;
    agent: AgentConfig;
    sessionId: string;
    contextTokens?: number;
    contextWindow?: number;
    tools?: string[];
  }): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_sessions (adw_id, agent, coding_agent, model, color,
           session_id, context_tokens, context_window, tools_json, created_at, last_used_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(adw_id, agent) DO UPDATE SET model=excluded.model,
           color=excluded.color, session_id=excluded.session_id,
           context_tokens=excluded.context_tokens,
           context_window=excluded.context_window,
           tools_json=excluded.tools_json,
           last_used_at=excluded.last_used_at`,
      )
      .run(
        params.adwId,
        params.agent.name,
        params.agent.coding_agent,
        params.agent.model,
        params.agent.color,
        params.sessionId,
        params.contextTokens ?? 0,
        params.contextWindow ?? 0,
        JSON.stringify(params.tools ?? []),
        ts,
        ts,
      );
  }

  /** Read-only helper for the observe scripts and the visualizer. */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }
}
