/**
 * CREATE TABLE IF NOT EXISTS never revisits a table that already exists, so a
 * column added to SCHEMA alone is invisible on every database that predates it
 * — and every database on a machine that has ever run a workflow predates it.
 * MIGRATIONS is the other half, and forgetting it fails silently: the run
 * writes fine, the reader's UPDATE throws "no such column" at the one moment
 * someone is trying to use the feature.
 *
 * `archived` shipped without its entry and proved this. These tests are the
 * guard that the next column does not.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Tracer } from "./tracer.ts";

let root: string;
let dbPath: string;
let jsonl: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sfo-tracer-"));
  dbPath = path.join(root, "sfo.db");
  jsonl = path.join(root, "events.jsonl");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function columns(table: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
  db.close();
  return names;
}

/** A sessions table as it looked before any reader-owned column existed. */
function seedAncientDb(): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (
    adw_id TEXT PRIMARY KEY,
    adw_name TEXT,
    request TEXT,
    status TEXT,
    engineer TEXT,
    started_at TEXT, ended_at TEXT,
    total_tokens INTEGER DEFAULT 0
  )`);
  db.prepare("INSERT INTO sessions (adw_id, status) VALUES (?, ?)").run("adw_old", "success");
  db.close();
}

const READER_OWNED = ["archived", "rating", "note", "feedback_at"];

describe("schema", () => {
  test("a fresh database has the reader-owned columns", () => {
    const tracer = new Tracer(dbPath, jsonl);
    tracer.close();
    for (const column of READER_OWNED) expect(columns("sessions")).toContain(column);
  });

  test("a database older than them grows them on open", () => {
    seedAncientDb();
    expect(columns("sessions")).not.toContain("rating");

    const tracer = new Tracer(dbPath, jsonl);
    tracer.close();

    const after = columns("sessions");
    for (const column of [...READER_OWNED, "target", "repo_path", "nano_aiu"]) {
      expect(after).toContain(column);
    }
  });

  test("migrating preserves the rows already there", () => {
    seedAncientDb();
    const tracer = new Tracer(dbPath, jsonl);
    tracer.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT adw_id, status, rating FROM sessions").get() as {
      adw_id: string;
      status: string;
      rating: number | null;
    };
    db.close();
    expect(row.adw_id).toBe("adw_old");
    expect(row.status).toBe("success");
    expect(row.rating).toBeNull();
  });

  test("opening twice is a no-op — migrations never double-apply", () => {
    new Tracer(dbPath, jsonl).close();
    const first = columns("sessions").length;
    new Tracer(dbPath, jsonl).close();
    expect(columns("sessions").length).toBe(first);
  });
});

describe("feedback columns", () => {
  test("no tracer method writes them", () => {
    const tracer = new Tracer(dbPath, jsonl);
    tracer.sessionStart({ adwId: "adw_x", engineer: "me", adwName: "adw_scout" });
    tracer.sessionFinish("adw_x", true);
    tracer.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT rating, note, feedback_at FROM sessions WHERE adw_id = ?")
      .get("adw_x") as { rating: null; note: null; feedback_at: null };
    db.close();
    expect(row.rating).toBeNull();
    expect(row.note).toBeNull();
    expect(row.feedback_at).toBeNull();
  });

  test("a run rejoining an adw_id leaves feedback alone", () => {
    const tracer = new Tracer(dbPath, jsonl);
    tracer.sessionStart({ adwId: "adw_y", engineer: "me", adwName: "adw_plan" });
    tracer.sessionFinish("adw_y", true);
    tracer.close();

    // The reader judges the run…
    const writable = new DatabaseSync(dbPath);
    writable
      .prepare("UPDATE sessions SET rating = ?, note = ? WHERE adw_id = ?")
      .run(4, "plan was tight", "adw_y");
    writable.close();

    // …and a chained ADW joins the same id afterwards.
    const next = new Tracer(dbPath, jsonl);
    next.sessionStart({ adwId: "adw_y", engineer: "me", adwName: "adw_build" });
    next.sessionFinish("adw_y", true);
    next.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT rating, note FROM sessions WHERE adw_id = ?")
      .get("adw_y") as { rating: number; note: string };
    db.close();
    expect(row.rating).toBe(4);
    expect(row.note).toBe("plan was tight");
  });
});
