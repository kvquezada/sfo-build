/**
 * Waterfall geometry and event payload shapes.
 *
 * Pure functions only — the page computes lanes on the server and the client
 * recomputes them every tick while a run is live, so nothing here may touch
 * React, the DOM, or the clock. `nowMs` is always passed in.
 */

import type { AgentSessionRow, EventRow, PhaseRow, SessionRow } from "./db.ts";

export function ts(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}

/** Compact offset label for the time axis: 0s, 30s, 1m, 1m30s, 1h05m. */
export function offset(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m${String(rem).padStart(2, "0")}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${String(rem).padStart(2, "0")}m` : `${h}h`;
}

/** Wall-clock span as a readable duration. Unlike `duration`, tolerates a live end. */
export function span(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600].map(
  (s) => s * 1000,
);

/** Evenly-stepped axis ticks over a span, at most `max` of them. */
export function axisTicks(spanMs: number, max = 7): { pct: number; label: string }[] {
  const total = Math.max(spanMs, 1);
  const step = TICK_STEPS_MS.find((s) => total / s <= max) ?? 3_600_000;
  const out: { pct: number; label: string }[] = [];
  for (let t = 0; t <= total; t += step) out.push({ pct: (t / total) * 100, label: offset(t) });
  return out;
}

/** "#c084fc" + alpha → rgba(), for inline block fills. Invalid input disappears. */
export function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return "transparent";
  const n = Number.parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ── lanes ────────────────────────────────────────────────────────────────────

const ENGINEER_COLOR = "#22d3ee";
const CODE_COLOR = "#fbbf24";
const AGENT_FALLBACK = ["#c084fc", "#38bdf8", "#f472b6", "#a3e635", "#fb923c"];

export interface Lane {
  id: string;
  label: string;
  kind: string;
  color: string;
  /** Second line under the lane name — the model, or what the lane is. */
  meta: string;
  /**
   * Context the agent carried into its last turn. `pct` is null when no
   * ceiling is declared for the model, and the lane then shows the token
   * count alone rather than a percentage of nothing.
   */
  context: { used: number; window: number | null; pct: number | null } | null;
  phases: PhaseRow[];
}

/**
 * One lane per actor: the engineer, the workspace, then an agent per owner in
 * first-use order. A lane exists because something ran in it — an empty lane
 * is a row of nothing, so `code` and the agents only appear when used.
 *
 * On a run that crossed repos, the actor is the agent AND the repo it stood in:
 * two scout phases over two checkouts are two lanes. Not for the geometry —
 * they run in sequence and would sit side by side in one row perfectly well —
 * but for the context bar. Each is its own Copilot session with its own window
 * occupancy, and one lane cannot honestly show two numbers.
 */
export function lanes(
  session: SessionRow,
  phases: PhaseRow[],
  agents: AgentSessionRow[],
  windows: Record<string, number> = {},
): Lane[] {
  const out: Lane[] = [
    {
      id: "engineer",
      label: session.engineer ?? "engineer",
      kind: "engineer",
      color: ENGINEER_COLOR,
      meta: "engineer",
      context: null,
      phases: phases.filter((p) => p.kind === "engineer"),
    },
  ];

  const code = phases.filter((p) => p.kind === "code");
  if (code.length) {
    out.push({
      id: "code",
      label: "code",
      kind: "code",
      color: CODE_COLOR,
      meta: "deterministic",
      context: null,
      phases: code,
    });
  }

  // Split by repo only when there is more than one — a single-target run keeps
  // the lane it has always had, named for the agent alone.
  const repos = new Set(phases.map((p) => p.target ?? "").filter(Boolean));
  const split = repos.size > 1;
  const key = (p: PhaseRow) => (split ? `${p.owner}@${p.target ?? ""}` : p.owner);

  const actors: { id: string; owner: string; target: string }[] = [];
  for (const p of phases) {
    if (p.kind !== "agent" || !p.owner) continue;
    const id = key(p);
    if (actors.some((a) => a.id === id)) continue;
    actors.push({ id, owner: p.owner, target: split ? (p.target ?? "") : "" });
  }
  for (const [i, actor] of actors.entries()) {
    const info = agentFor(agents, actor.owner, actor.target);
    out.push({
      id: `agent:${actor.id}`,
      label: actor.owner,
      kind: "agent",
      color: info?.color || AGENT_FALLBACK[i % AGENT_FALLBACK.length] || "#c084fc",
      meta: actor.target ? `${actor.target} · ${info?.model ?? "agent"}` : (info?.model ?? "agent"),
      context: laneContext(info, windows),
      phases: phases.filter((p) => p.kind === "agent" && p.owner === actor.owner && key(p) === actor.id),
    });
  }
  return out;
}

/**
 * The agent_sessions row for one lane.
 *
 * Rows are keyed `scout@api` since the cross-repo change; anything written
 * before it is keyed on the bare agent name. Both are read, newest convention
 * first, so an old run still finds its model and its context figure.
 */
export function agentFor(
  agents: AgentSessionRow[],
  owner: string,
  target: string,
): AgentSessionRow | undefined {
  if (target) {
    const exact = agents.find((a) => a.agent === `${owner}@${target}` || (a.agent === owner && a.target === target));
    if (exact) return exact;
  }
  return agents.find((a) => a.agent === owner || a.agent.startsWith(`${owner}@`));
}

/**
 * Window occupancy for an agent lane.
 *
 * The numerator is measured and the denominator is declared, and they come
 * from different places on purpose: `context_tokens` is what the stream
 * reported, while the ceiling is whatever the operator wrote in
 * sfo.config.yaml, because Copilot's `--context` is a tier and no catalog
 * exposes a size. A model the config does not list yields `pct: null` — the
 * lane shows what it measured and claims nothing about how full it is.
 *
 * If a harness ever DOES report a real window, that number wins: a measured
 * ceiling beats a declared one.
 */
function laneContext(info: AgentSessionRow | undefined, windows: Record<string, number>) {
  const used = info?.context_tokens ?? 0;
  if (!used) return null;
  const reported = info?.context_window ?? 0;
  const ceiling = reported > 0 ? reported : (windows[info?.model ?? ""] ?? 0);
  if (!ceiling) return { used, window: null, pct: null };
  return { used, window: ceiling, pct: Math.min(100, (used / ceiling) * 100) };
}

// ── timeline ─────────────────────────────────────────────────────────────────

/**
 * The engineer's request opens the run and owns the head of the timeline. It
 * lasts microseconds, so time-proportional it would be a hairline; it gets an
 * exclusive leading zone instead and every later phase maps into the rest.
 *
 * The share shrinks as the run grows. The zone wants to be roughly a constant
 * number of pixels — enough to read the ask — and the track grows with the
 * phase count, so holding the percentage fixed would turn a 6ms phase into a
 * banner across a thirty-phase run.
 */
const REQUEST_ZONE_PCT = 14;
const ZONE_BASELINE_PHASES = 9;

function requestZone(timed: number): number {
  if (timed <= ZONE_BASELINE_PHASES) return REQUEST_ZONE_PCT;
  return Math.max(5, (REQUEST_ZONE_PCT * ZONE_BASELINE_PHASES) / timed);
}

/** A phase shorter than this reads as a sliver. Nothing renders narrower. */
const MIN_BLOCK_PCT = 5.5;

export interface Geometry {
  /** Width of the reserved request zone, in track-%. 0 when no request phase. */
  zone: number;
  requestId: string | null;
  ticks: { pct: number; label: string }[];
  blocks: Record<string, { left: number; width: number }>;
  /** Wall-clock end of the timeline — `now` while the run is live. */
  endMs: number;
  startMs: number;
}

export function geometry(
  session: SessionRow,
  phases: PhaseRow[],
  nowMs: number,
): Geometry {
  const live = session.status === "running";

  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  for (const t of [ts(session.started_at), ts(session.ended_at)]) {
    if (Number.isFinite(t)) {
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
  }
  for (const p of phases) {
    const a = ts(p.started_at);
    const b = ts(p.ended_at);
    if (Number.isFinite(a)) {
      t0 = Math.min(t0, a);
      t1 = Math.max(t1, a);
    }
    if (Number.isFinite(b)) t1 = Math.max(t1, b);
  }
  if (live) t1 = Math.max(t1, nowMs);
  if (!Number.isFinite(t0)) {
    t0 = nowMs;
    t1 = nowMs + 1000;
  }
  if (t1 - t0 < 1000) t1 = t0 + 1000;

  const request = phases.find((p) => p.kind === "engineer" && p.started_at) ?? null;
  const timed = phases.filter((p) => p.started_at && p.phase_id !== request?.phase_id).length;
  const zone = request ? requestZone(timed) : 0;

  // Where the post-request timeline begins: the earliest non-engineer start,
  // NOT the request phase's end. A second ADW joining the session pushes the
  // request row's ended_at forward, which would throw finished phases behind
  // the origin and give them negative offsets.
  let origin = t0;
  if (request) {
    let earliest = Number.POSITIVE_INFINITY;
    for (const p of phases) {
      if (p.kind === "engineer") continue;
      const s = ts(p.started_at);
      if (Number.isFinite(s)) earliest = Math.min(earliest, s);
    }
    const end = ts(request.ended_at ?? request.started_at);
    origin = Number.isFinite(earliest)
      ? Math.max(earliest, t0)
      : Number.isFinite(end)
        ? Math.max(end, t0)
        : t0;
  }
  const total = Math.max(t1 - origin, 1000);

  return {
    zone,
    requestId: request?.phase_id ?? null,
    startMs: t0,
    endMs: t1,
    ticks: axisTicks(total).map((t) => ({
      pct: zone + (t.pct * (100 - zone)) / 100,
      label: t.label,
    })),
    blocks: layout(phases, request?.phase_id ?? null, zone, origin, total, nowMs),
  };
}

/**
 * Block positions in track-%, for every phase that has started.
 *
 * Phases are sequential by doctrine and the render must say so: blocks never
 * stack. Three rules, applied in order, keep that true inside a fixed track:
 *
 *  1. Nothing renders narrower than the floor — a 40ms commit is a real step
 *     and an invisible one is a lie by omission.
 *  2. When the row then overruns the track, idle gaps are squeezed first.
 *     Gaps carry the least information here; phases run back to back.
 *  3. Only then are the long blocks squeezed, and only their length ABOVE the
 *     floor is taken, proportionally. A uniform scale over everything would
 *     shrink the floored blocks straight back under the floor, which is how
 *     the floor silently stops working.
 */
function layout(
  phases: PhaseRow[],
  requestId: string | null,
  zone: number,
  origin: number,
  total: number,
  nowMs: number,
): Record<string, { left: number; width: number }> {
  const avail = 100 - zone - 0.4; // a hair of right margin
  const timed = phases
    .filter((p) => p.phase_id !== requestId && Number.isFinite(ts(p.started_at)))
    .map((p) => {
      const start = ts(p.started_at);
      let end = ts(p.ended_at);
      if (!Number.isFinite(end)) end = p.status === "running" ? nowMs : start;
      return {
        id: p.phase_id,
        left: ((start - origin) / total) * avail,
        width: ((Math.max(end, start) - start) / total) * avail,
      };
    })
    .sort((a, b) => a.left - b.left);
  if (!timed.length) return {};

  const widths = timed.map((b) => Math.max(b.width, MIN_BLOCK_PCT));
  // Idle time before each block. Overlapping starts read as no gap at all.
  const gaps = timed.map((b, i) =>
    i === 0 ? Math.max(b.left, 0) : Math.max(b.left - (timed[i - 1]!.left + timed[i - 1]!.width), 0),
  );

  let over = sum(widths) + sum(gaps) - avail;

  if (over > 0) {
    const total = sum(gaps);
    const keep = total > 0 ? Math.max(total - over, 0) / total : 0;
    for (const [i] of gaps.entries()) gaps[i] = gaps[i]! * keep;
    over -= Math.min(over, total);
  }

  if (over > 0) {
    const excess = sum(widths.map((w) => w - MIN_BLOCK_PCT));
    const keep = excess > 0 ? Math.max(excess - over, 0) / excess : 0;
    for (const [i] of widths.entries()) {
      widths[i] = MIN_BLOCK_PCT + (widths[i]! - MIN_BLOCK_PCT) * keep;
    }
    over -= Math.min(over, excess);
  }

  // More blocks than the track can hold even at the floor — every one is now
  // exactly the floor, and a uniform scale is the only answer left.
  if (over > 0) {
    const keep = avail / sum(widths);
    for (const [i] of widths.entries()) widths[i] = widths[i]! * keep;
  }

  const out: Record<string, { left: number; width: number }> = {};
  let edge = zone;
  for (const [i, b] of timed.entries()) {
    edge += gaps[i]!;
    out[b.id] = { left: edge, width: widths[i]! };
    edge += widths[i]!;
  }
  return out;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

// ── event payloads ───────────────────────────────────────────────────────────

export interface ToolCall {
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  label?: string;
  result_snippet?: string;
  /** `code` phases log their shell step here instead of under `tool`. */
  command?: string;
  operation?: string;
  returncode?: number;
  passed?: boolean;
}

export function payload(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* truncated or legacy payloads render raw */
  }
  return null;
}

/** A tool_call that reported failure. Payloads without the key count as ok. */
export function callOk(raw: string | null | undefined): boolean {
  const p = payload(raw);
  if (!p) return true;
  if ("ok" in p) return p["ok"] !== false;
  if ("passed" in p) return p["passed"] !== false;
  return true;
}

const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "description"];
const LABEL_MAX = 150;

function oneLine(value: string): string {
  const flat = value.replaceAll(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX)}…` : flat;
}

/** One line naming the call itself, not a JSON dump of it. */
export function eventLabel(event: EventRow): string {
  const p = payload(event.payload_json);
  if (event.type === "log" && typeof p?.["message"] === "string") {
    return oneLine(p["message"] as string);
  }
  if (event.type === "error" && typeof p?.["error"] === "string") {
    return oneLine(p["error"] as string);
  }
  if (event.type === "handoff" && typeof p?.["summary"] === "string") {
    return oneLine(p["summary"] as string);
  }
  if (event.type === "tool_call" && p) {
    const call = p as ToolCall;
    if (typeof call.label === "string") return oneLine(call.label);
    if (typeof call.command === "string") return oneLine(`${call.operation ?? "run"}: ${call.command}`);
    if (call.tool) {
      const args = call.args ?? {};
      for (const key of ARG_KEYS) {
        const v = args[key];
        if (typeof v === "string" && v.trim()) return oneLine(`${call.tool}: ${v}`);
      }
      return call.tool;
    }
  }
  return oneLine(event.name || event.type || "");
}

/** How long an event took. tool_calls carry their own end in the payload. */
export function eventDuration(event: EventRow): number {
  const a = ts(event.started_at);
  const b = ts(event.ended_at);
  if (Number.isFinite(a) && Number.isFinite(b)) return b - a;
  const p = payload(event.payload_json);
  const end = ts(typeof p?.["ended_at"] === "string" ? (p["ended_at"] as string) : null);
  if (Number.isFinite(a) && Number.isFinite(end)) return end - a;
  return Number.NaN;
}

export function prettyJson(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
