"use client";

import { useEffect, useState } from "react";

import type { AgentSessionRow, EnvelopeRow, EventRow, GateRow, PhaseRow } from "@/lib/db.ts";
import { clip, clock, credits, money, num } from "@/lib/format.ts";
import {
  callOk,
  eventDuration,
  eventLabel,
  payload,
  prettyJson,
  span,
  ts,
  type ToolCall,
} from "@/lib/trace.ts";
import { Status } from "@/components/chips.tsx";

interface Check {
  item: string;
  ok: boolean;
  note: string;
}

/**
 * Everything one phase did, opened from its block in the waterfall.
 *
 * Two columns because they answer different questions: the left is what the
 * phase was *given and produced* — its config, its gates, its envelope — and
 * the right is what it *did*, in order. Sections start closed: the point of
 * clicking a block is to narrow, and a panel that dumps everything is the
 * flat list this view replaced.
 */
export function PhaseDetail({
  phase,
  agent,
  events,
  gates,
  envelopes,
  adwId,
  now,
  onClose,
}: {
  phase: PhaseRow;
  agent: AgentSessionRow | null;
  events: EventRow[];
  gates: GateRow[];
  envelopes: EnvelopeRow[];
  adwId: string;
  now: number;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Selecting a different phase is a fresh question — a section left open on
  // the last phase is not an answer about this one. Keyed on phase_id rather
  // than the object, which the poll replaces wholesale every 1.5s.
  useEffect(() => {
    setOpen(new Set());
    setExpanded(new Set());
  }, [phase.phase_id]);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const ordered = [...events].sort((a, b) => a.rowid - b.rowid);
  const config = phase.kind === "agent" ? agentConfig(ordered) : null;
  const request = phase.kind === "engineer" ? requestText(ordered) : null;
  const spend = phaseSpend(ordered);
  const prompts = usePrompts(adwId, phase.kind === "agent" ? phase.owner : null);

  const start = ts(phase.started_at);
  const end = phase.status === "running" ? now : ts(phase.ended_at);
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? end - start : Number.NaN;

  const section = (id: string, title: string, count: number | null, body: React.ReactNode) => (
    <div className="pd-section" key={id}>
      <button type="button" className="pd-head" onClick={() => setOpen((s) => toggle(s, id))}>
        <span className="pd-chev">{open.has(id) ? "▾" : "▸"}</span>
        <span className="pd-title">{title}</span>
        {count === null ? null : <span className="pd-count">{count}</span>}
      </button>
      {open.has(id) ? <div className="pd-body">{body}</div> : null}
    </div>
  );

  return (
    <div className="panel pd" data-kind={phase.kind}>
      <div className="pd-top">
        <span className="pd-name">{phase.name}</span>
        <Status status={phase.status} />
        {Number.isFinite(elapsed) ? <span className="pd-dur">{span(elapsed)}</span> : null}
        <span className="pd-tags">
          <span className="pd-tag">
            <b>owner</b> {phase.owner}
          </span>
          <span className="pd-tag">
            <b>kind</b> {phase.kind}
          </span>
          <span className="pd-tag">
            <b>attempt</b> {phase.attempt + 1}/{phase.retries + 1}
          </span>
          <span className="pd-tag">
            <b>seq</b> {phase.seq}
          </span>
        </span>
        <button type="button" className="pd-close" onClick={onClose} title="close">
          ✕
        </button>
      </div>

      {phase.error ? <div className="phase-error">{phase.error}</div> : null}

      <div className="pd-grid">
        <div className="pd-col">
          {request
            ? section("request", "request", null, <p className="pd-prose">{request}</p>)
            : null}

          {phase.description
            ? section(
                "description",
                "description",
                null,
                <p className="pd-prose">{phase.description}</p>,
              )
            : null}

          {config
            ? section(
                "config",
                "agent config",
                null,
                <dl className="kv">
                  {Object.entries(config).map(([k, v]) => (
                    <div key={k} className="pd-cfg">
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>,
              )
            : null}

          {phase.kind === "agent"
            ? section(
                "prompts",
                "compiled prompts",
                prompts.state === "ready" ? prompts.panels.length : null,
                prompts.state === "loading" ? (
                  <div className="pd-faint">loading…</div>
                ) : prompts.state === "error" ? (
                  <div className="pd-faint">prompts unavailable</div>
                ) : !prompts.panels.length ? (
                  <div className="pd-faint">no compiled prompts recorded for this agent</div>
                ) : (
                  prompts.panels.map((p) => (
                    <div key={p.id} className="pd-prompt">
                      <button
                        type="button"
                        className="pd-head pd-sub"
                        onClick={() => setExpanded((s) => toggle(s, `prompt:${p.id}`))}
                      >
                        <span className="pd-chev">
                          {expanded.has(`prompt:${p.id}`) ? "▾" : "▸"}
                        </span>
                        <span className="pd-title">{p.id} prompt</span>
                        <span className="pd-count">{p.lines} lines</span>
                      </button>
                      {expanded.has(`prompt:${p.id}`) ? (
                        <pre className="pd-pre">{p.text}</pre>
                      ) : null}
                    </div>
                  ))
                ),
              )
            : null}

          {section(
            "gates",
            "gates",
            gates.length,
            gates.length ? (
              gates.map((g) => {
                const checks = parseChecks(g.checks_json);
                const bad = checks.filter((c) => !c.ok).length;
                return (
                  <div key={g.id} className="gate">
                    <div className="gate-head">
                      <span style={{ color: g.passed ? "var(--success)" : "var(--fail)" }}>
                        {g.passed ? "✓" : "✗"}
                      </span>
                      <span>{g.gate}</span>
                      <span className="pd-faint">
                        {bad ? `${bad} of ${checks.length} failed` : `${checks.length} checked`}
                        {" · attempt "}
                        {g.attempt}
                        {" · "}
                        {clock(g.created_at)}
                      </span>
                    </div>
                    {checks.map((c, i) => (
                      <div key={i} className="check" data-ok={String(c.ok)}>
                        <span className="item">{c.item}</span>
                        {c.note ? <span>— {clip(c.note, 200)}</span> : null}
                      </div>
                    ))}
                    {violations(g).map((v, i) => (
                      <div key={i} className="check" data-ok="false">
                        <span>{v}</span>
                      </div>
                    ))}
                  </div>
                );
              })
            ) : (
              <div className="pd-faint">no gate ran on this phase</div>
            ),
          )}

          {spend
            ? section(
                "spend",
                "spend",
                null,
                <table className="pd-usage">
                  <tbody>
                    {spend.map((r) => (
                      <tr key={r.label} data-total={String(Boolean(r.total))} title={r.note}>
                        <td>{r.label}</td>
                        <td>{r.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>,
              )
            : null}

          {section(
            "outputs",
            "outputs",
            envelopes.length,
            envelopes.length ? (
              envelopes.map((env) => (
                <div key={env.envelope_id} className="pd-output">
                  <div className="gate-head">
                    <span>{env.output_type}</span>
                    <span className="pd-faint">
                      {env.agent} · attempt {env.attempt}
                    </span>
                    <span style={{ color: env.valid ? "var(--success)" : "var(--fail)" }}>
                      {env.valid ? "valid" : "invalid"}
                    </span>
                  </div>
                  <pre className="pd-pre">{prettyJson(env.payload_json)}</pre>
                </div>
              ))
            ) : (
              <div className="pd-faint">this phase produced no envelope</div>
            ),
          )}
        </div>

        <div className="pd-col">
          <h3 className="pd-events-head">activity · {ordered.length} events</h3>
          {ordered.length ? (
            <div className="pd-events">
              {ordered.map((e) => {
                const ms = eventDuration(e);
                const bad = e.type === "error" || e.type === "gate_fail" || !callOk(e.payload_json);
                return (
                  <div key={e.event_id} className="pd-event">
                    <button
                      type="button"
                      className="pd-ev-row"
                      data-t={e.type}
                      data-on={String(expanded.has(e.event_id))}
                      onClick={() => setExpanded((s) => toggle(s, e.event_id))}
                    >
                      <span className="ev-time">{clock(e.started_at)}</span>
                      <span className="ev-type">{e.type}</span>
                      <span className="ev-body" data-err={String(bad)}>
                        {eventLabel(e)}
                      </span>
                      <span className="pd-ev-side">
                        {Number.isFinite(ms) ? span(ms) : ""}
                        {e.tokens ? ` · ${num(e.tokens)} tok` : ""}
                      </span>
                    </button>
                    {expanded.has(e.event_id) ? <EventPayload event={e} /> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="pd-faint">no events recorded for this phase</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A tool call's args and result read better apart than as one JSON blob. */
function EventPayload({ event }: { event: EventRow }) {
  const p = payload(event.payload_json);
  const call = event.type === "tool_call" ? (p as ToolCall | null) : null;
  if (call && (call.tool || call.command)) {
    return (
      <div className="pd-payload">
        <div className="pd-faint">
          {call.tool ?? call.operation}
          {call.ok === false || call.passed === false ? " · failed" : ""}
          {call.returncode === undefined ? "" : ` · exit ${call.returncode}`}
        </div>
        <h4>args</h4>
        <pre className="pd-pre">
          {call.command ?? JSON.stringify(call.args ?? {}, null, 2)}
        </pre>
        {call.result_snippet ? (
          <>
            <h4>result</h4>
            <pre className="pd-pre">{call.result_snippet}</pre>
          </>
        ) : null}
      </div>
    );
  }
  return (
    <div className="pd-payload">
      {event.payload_json ? (
        <pre className="pd-pre">{prettyJson(event.payload_json)}</pre>
      ) : (
        <div className="pd-faint">no payload</div>
      )}
    </div>
  );
}

// ── payload readers ──────────────────────────────────────────────────────────

/** The agent's configuration, carried on its phase's `agent_start` event. */
function agentConfig(events: EventRow[]): Record<string, string> | null {
  const start = events.find((e) => e.type === "agent_start");
  const p = payload(start?.payload_json);
  if (!p) return null;
  const out: Record<string, string> = {};
  for (const key of ["coding_agent", "model", "thinking", "purpose", "session_id"]) {
    const v = p[key];
    if (typeof v === "string" && v) out[key.replace("_", " ")] = v;
  }
  const tools = p["tools"];
  out["tools"] = tools === null ? "all tools" : Array.isArray(tools) ? tools.join(", ") : "—";
  return Object.keys(out).length ? out : null;
}

/** The incoming ask, logged by every ADW's request phase as an `input` payload. */
function requestText(events: EventRow[]): string | null {
  for (const e of events) {
    if (e.type !== "log") continue;
    const p = payload(e.payload_json);
    const input = p?.["input"];
    if (typeof input === "string" && input.trim()) return input;
  }
  return null;
}

/**
 * What this phase's agent run cost, tokens first and dollars last.
 *
 * The tokens explain the bill and the bill is the answer, so the table reads
 * top-down as cause then effect. `nano_aiu` is what makes the dollar row real:
 * GitHub documents it as AI-credit cost and prices a credit at $0.01, so the
 * figure is converted rather than modelled from token counts.
 */
interface SpendRow {
  label: string;
  /** Pre-formatted so a token count and a dollar figure can share one column. */
  text: string;
  note?: string;
  total?: boolean;
}

function phaseSpend(events: EventRow[]): SpendRow[] | null {
  const end = events.find((e) => e.type === "agent_end");
  const usage = payload(end?.payload_json)?.["usage"];
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, number>;
  const aiu = u["nano_aiu"] ?? 0;
  const counts = [
    { label: "prompt tokens", value: u["prompt_tokens"] ?? 0 },
    { label: "cache read", value: u["cache_read_tokens"] ?? 0 },
    { label: "cache write", value: u["cache_write_tokens"] ?? 0 },
    { label: "premium requests", value: u["premium_requests"] ?? 0 },
  ];
  if (!counts.some((r) => r.value) && !aiu) return null;
  return [
    ...counts.map((r) => ({ label: r.label, text: num(r.value) })),
    { label: "AI credits", text: credits(aiu).toFixed(3), note: `${num(aiu)} nanoAIU` },
    { label: "cost est.", text: money(aiu), note: "AI credits at $0.01 each", total: true },
  ];
}

function parseChecks(raw: string | null): Check[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c: Record<string, unknown>) => ({
      item: typeof c["item"] === "string" ? c["item"] : "",
      ok: c["ok"] === true,
      note: typeof c["note"] === "string" ? c["note"] : "",
    }));
  } catch {
    return [];
  }
}

function violations(g: GateRow): string[] {
  try {
    const parsed: unknown = JSON.parse(g.violations_json ?? "[]");
    if (Array.isArray(parsed)) {
      return parsed.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    }
  } catch {
    /* fall through to the raw column */
  }
  return g.violations_json ? [g.violations_json] : [];
}

// ── compiled prompts ─────────────────────────────────────────────────────────

interface PromptPanel {
  id: string;
  text: string;
  lines: number;
}

/**
 * The exact prompts an agent was sent, off the session directory.
 *
 * Fetched rather than passed down: they are files, the db has no copy, and
 * they are large enough that shipping every phase's prompts with the page
 * would dwarf the trace itself. Cached module-wide so reopening a phase — or
 * a poll tick remounting this panel — never refetches.
 */
const PROMPT_CACHE = new Map<string, PromptPanel[]>();

function usePrompts(adwId: string, owner: string | null) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [panels, setPanels] = useState<PromptPanel[]>([]);

  useEffect(() => {
    if (!owner) {
      setState("idle");
      setPanels([]);
      return;
    }
    const key = `${adwId}:${owner}`;
    const cached = PROMPT_CACHE.get(key);
    if (cached) {
      setPanels(cached);
      setState("ready");
      return;
    }
    let live = true;
    setState("loading");
    fetch(`/api/sessions/${adwId}/agents/${owner}/prompts`)
      .then((r) => r.json() as Promise<{ system: string | null; user: string | null }>)
      .then((body) => {
        const built: PromptPanel[] = [];
        for (const id of ["system", "user"] as const) {
          const text = body[id];
          if (text) built.push({ id, text, lines: text.split("\n").length });
        }
        PROMPT_CACHE.set(key, built);
        if (!live) return;
        setPanels(built);
        setState("ready");
      })
      .catch(() => {
        if (live) setState("error");
      });
    return () => {
      live = false;
    };
  }, [adwId, owner]);

  return { state, panels };
}
