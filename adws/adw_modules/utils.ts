/** Small shared helpers. Anything bigger belongs in its own module. */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Expand a leading `~` — config paths are written the way a human types them. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Absolute, `~`-expanded, symlink-free-enough for comparison and spawning. */
export function absolute(p: string, base = process.cwd()): string {
  return path.resolve(base, expandHome(p));
}

export function newId(length = 8): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/**
 * UUIDv5 over the DNS namespace, derived from (adw_id, agent).
 *
 * Both CLIs demand a real UUID for `--session-id`, so SSSF's
 * `sssf-{adw_id}-{agent}-{rand}` format is simply invalid here. Deriving it
 * keeps the property that format was reaching for: the same run + the same
 * agent always names the same session, so `agent_map.json` can rejoin a live
 * context window instead of paying for a cold one.
 */
const UUID_NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export function uuidv5(name: string, namespace = UUID_NAMESPACE_DNS): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function agentSessionId(adwId: string, agent: string): string {
  return uuidv5(`sfo-build:${adwId}:${agent}`);
}

/**
 * The engineer's own environment, as their shell would hand it over.
 *
 * Agents and quality blocks are meant to see exactly what the operator sees:
 * their PATH, their toolchains, their globally installed packages. Bun and
 * Node do not interpose a venv the way `uv run` did for SSSF, so this is a
 * plain copy — the function exists so that the one place that decides what a
 * child process inherits stays one place.
 */
export function operatorEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

/** CLI prompt arg: a file path resolves to its contents, else inline text. */
export function resolvePrompt(arg: string): string {
  try {
    const p = expandHome(arg);
    if (existsSync(p) && statSync(p).isFile()) return readFileSync(p, "utf8");
  } catch {
    // not a path — fall through and treat it as literal prompt text
  }
  return arg;
}

export function engineerName(): string {
  const fromEnv = (process.env["ENGINEER_NAME"] ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (name) return name;
  } catch {
    // no git identity configured — fall through
  }
  return process.env["USER"] ?? "engineer";
}

export function clip(text: string, limit: number): string {
  const t = String(text);
  return t.length <= limit ? t : `${t.slice(0, limit).trimEnd()}…`;
}

export function humanSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

/** `argv` as a copy-pasteable shell line, for logs and artifacts only. */
export function shellJoin(argv: string[]): string {
  return argv
    .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

/**
 * Zod's error prose is terser than pydantic's, and a correction turn is only as
 * good as the sentence that provokes it. This is the ~20-line formatter the
 * risk table called for: one line per bad field, path first.
 */
export function formatZodError(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return String((error as Error)?.message ?? error);
  return issues
    .map((raw) => {
      const issue = raw as {
        path?: (string | number)[];
        message?: string;
        expected?: string;
        received?: string;
      };
      const where = issue.path?.length ? issue.path.join(".") : "(root)";
      const detail =
        issue.expected && issue.received
          ? ` (expected ${issue.expected}, got ${issue.received})`
          : "";
      return `${where}: ${issue.message ?? "invalid"}${detail}`;
    })
    .join("; ");
}
