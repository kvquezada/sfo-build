/**
 * Declared context ceilings, read from the roster config.
 *
 * The stream cannot supply one: Copilot's `--context` is a tier rather than a
 * number, so `agent_sessions.context_window` is 0 on every row ever written.
 * A percentage therefore needs a denominator the operator declares, and this
 * reads it from the same file that declares the roster — never from a table
 * baked into the UI, which would be a second source of truth the operator
 * cannot edit.
 *
 * A model with no declared ceiling gets NO percentage. That is the point: an
 * absent number stays absent rather than becoming a plausible-looking one.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export const CONFIG_PATH =
  process.env["SFO_CONFIG"] ??
  path.join(process.cwd(), "..", "..", "adws", "adw_sfo_config", "sfo.config.yaml");

let cache: { mtime: number; windows: Record<string, number> } | null = null;

/**
 * Re-read when the file changes. The config is edited by hand while the UI is
 * open — that is the whole workflow for tuning these numbers — so caching it
 * for the life of the server would make every correction look like it did
 * nothing until a restart.
 */
export function modelWindows(): Record<string, number> {
  if (!existsSync(CONFIG_PATH)) return {};
  let mtime: number;
  try {
    mtime = statSync(CONFIG_PATH).mtimeMs;
  } catch {
    return cache?.windows ?? {};
  }
  if (cache && cache.mtime === mtime) return cache.windows;

  const windows: Record<string, number> = {};
  try {
    const raw = parse(readFileSync(CONFIG_PATH, "utf8")) as {
      models?: Record<string, { context_window?: unknown }>;
    } | null;
    for (const [model, entry] of Object.entries(raw?.models ?? {})) {
      const value = Number(entry?.context_window);
      // A malformed row is a missing ceiling, not a zero one.
      if (Number.isFinite(value) && value > 0) windows[model] = value;
    }
  } catch {
    // A half-saved config mid-edit must not take the trace page down with it.
    return cache?.windows ?? {};
  }
  cache = { mtime, windows };
  return windows;
}
