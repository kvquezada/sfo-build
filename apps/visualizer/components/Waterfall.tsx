"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  AgentSessionRow,
  EnvelopeRow,
  EventRow,
  GateRow,
  PhaseRow,
  SessionRow,
} from "@/lib/db.ts";
import { alpha, callOk, geometry, lanes, span, ts } from "@/lib/trace.ts";
import { compact, num } from "@/lib/format.ts";
import { PhaseDetail } from "@/components/PhaseDetail.tsx";

const GLYPH: Record<string, string> = {
  success: "✓",
  fail: "✗",
  running: "●",
  queued: "○",
};

/**
 * The run as swimlanes over one clock.
 *
 * Lanes are actors, not stages: reading down a column tells you who was working
 * at a moment, and reading across a lane tells you what one actor did all run.
 * A phase is a button — the whole breakdown of its activity hangs off the click
 * rather than being spilled onto the page, because a ten-phase run has hundreds
 * of events and only one phase is ever the question.
 */
export function Waterfall({
  session,
  phases,
  agents,
  windows,
  events,
  gates,
  envelopes,
}: {
  session: SessionRow;
  phases: PhaseRow[];
  agents: AgentSessionRow[];
  /** Declared context ceilings by model, from sfo.config.yaml. */
  windows: Record<string, number>;
  events: EventRow[];
  gates: GateRow[];
  envelopes: EnvelopeRow[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow(session.status === "running");

  const rows = useMemo(
    () => lanes(session, phases, agents, windows),
    [session, phases, agents, windows],
  );
  const geo = useMemo(() => geometry(session, phases, now), [session, phases, now]);

  // A selection outlives a poll tick, but not a phase vanishing from the run.
  const phase = phases.find((p) => p.phase_id === selected) ?? null;

  const ticksByPhase = useMemo(() => {
    const map = new Map<string, { t: number; ok: boolean }[]>();
    for (const e of events) {
      if (e.type !== "tool_call" || !e.phase_id) continue;
      const list = map.get(e.phase_id) ?? [];
      list.push({ t: ts(e.started_at), ok: callOk(e.payload_json) });
      map.set(e.phase_id, list);
    }
    return map;
  }, [events]);

  /** Tool-call marks inside a block, positioned against the block's own span. */
  function marks(p: PhaseRow): { x: number; ok: boolean }[] {
    const start = ts(p.started_at);
    if (!Number.isFinite(start)) return [];
    let end = ts(p.ended_at);
    if (!Number.isFinite(end)) end = p.status === "running" ? now : start;
    const width = Math.max(end - start, 1);
    return (ticksByPhase.get(p.phase_id) ?? [])
      .filter((m) => Number.isFinite(m.t))
      .map((m) => ({ x: Math.min(Math.max(((m.t - start) / width) * 100, 1), 99), ok: m.ok }));
  }

  function blockMs(p: PhaseRow): number {
    const start = ts(p.started_at);
    if (!Number.isFinite(start)) return Number.NaN;
    const end = p.status === "running" ? now : ts(p.ended_at);
    return Number.isFinite(end) ? end - start : Number.NaN;
  }

  function place(p: PhaseRow): { left: string; width: string } | null {
    if (p.phase_id === geo.requestId && geo.zone > 0) {
      return { left: "0.4%", width: `${geo.zone - 0.8}%` };
    }
    const b = geo.blocks[p.phase_id];
    return b ? { left: `${b.left}%`, width: `${b.width}%` } : null;
  }

  if (!phases.length) {
    return <div className="panel empty">no phases recorded for this run</div>;
  }

  return (
    <>
      <div className="wf-scroll">
        <div className="waterfall" style={{ "--track-min": `${trackMin(phases, geo.zone)}px` } as React.CSSProperties}>
        <div className="wf-row wf-axis">
          <div className="wf-label" />
          <div className="wf-track">
            {geo.zone ? (
              <span className="wf-zone" style={{ width: `${geo.zone}%` }}>
                request
              </span>
            ) : null}
            {geo.ticks.map((t, i) => (
              <span key={i} className="wf-tick" style={{ left: `${t.pct}%` }}>
                {t.label}
              </span>
            ))}
          </div>
        </div>

        {rows.map((lane) => {
          const queued = lane.phases.filter((p) => !p.started_at);
          return (
            <div key={lane.id} className="wf-row wf-lane" data-kind={lane.kind}>
              <div className="wf-label">
                <span className="wf-name" style={{ color: lane.color }}>
                  <span className="wf-swatch" style={{ background: lane.color }} />
                  {lane.label}
                </span>
                <span className="wf-meta">{lane.meta}</span>
                {lane.context ? (
                  <span
                    className="wf-ctx"
                    title={
                      lane.context.pct === null
                        ? `${num(lane.context.used)} context tokens carried into this ` +
                          `agent's last turn. No context ceiling is declared for ` +
                          `${lane.meta} in sfo.config.yaml, so there is no percentage ` +
                          `to show it against.`
                        : `${num(lane.context.used)} of ${num(lane.context.window)} ` +
                          `context tokens. The ceiling is declared in sfo.config.yaml, ` +
                          `not reported by the harness — Copilot exposes no window size.`
                    }
                  >
                    <span className="wf-ctx-head">
                      <span className="wf-ctx-tag">context</span>
                      <span className="wf-ctx-val">
                        {lane.context.pct === null
                          ? compact(lane.context.used)
                          : `${Math.round(lane.context.pct)}%`}
                      </span>
                    </span>
                    {lane.context.pct === null ? null : (
                      <span className="wf-ctx-bar">
                        <span
                          className="wf-ctx-fill"
                          style={{
                            width: `${Math.max(lane.context.pct, 1.5)}%`,
                            background: lane.color,
                          }}
                        />
                      </span>
                    )}
                  </span>
                ) : null}
              </div>

              <div className="wf-track">
                {geo.zone ? (
                  <span className="wf-divider" style={{ left: `${geo.zone}%` }} />
                ) : null}
                {geo.ticks.map((t, i) => (
                  <span key={i} className="wf-grid" style={{ left: `${t.pct}%` }} />
                ))}

                {lane.phases.map((p) => {
                  const at = place(p);
                  if (!at) return null;
                  const ms = blockMs(p);
                  return (
                    <button
                      key={p.phase_id}
                      type="button"
                      className="wf-block"
                      data-s={p.status}
                      data-on={String(p.phase_id === selected)}
                      style={{
                        ...at,
                        background: `linear-gradient(180deg, ${alpha(lane.color, 0.22)}, ${alpha(lane.color, 0.06)})`,
                        borderColor:
                          p.status === "fail" ? "var(--fail)" : alpha(lane.color, 0.55),
                      }}
                      title={`${p.name} — ${p.status}${p.description ? `\n${p.description}` : ""}`}
                      onClick={() =>
                        setSelected(p.phase_id === selected ? null : p.phase_id)
                      }
                    >
                      <span className="wf-b-top">
                        <span className="wf-b-mark" data-s={p.status}>
                          {GLYPH[p.status] ?? "○"}
                        </span>
                        <span className="wf-b-name">{p.name}</span>
                        {Number.isFinite(ms) ? (
                          <span className="wf-b-dur">{span(ms)}</span>
                        ) : null}
                      </span>
                      <span className="wf-b-desc">{p.description}</span>
                      {p.attempt > 0 ? (
                        <span className="wf-b-retry">retry {p.attempt}</span>
                      ) : null}
                      {marks(p).map((m, i) => (
                        <span
                          key={i}
                          className="wf-mark"
                          data-err={String(!m.ok)}
                          style={{ left: `${m.x}%` }}
                        />
                      ))}
                    </button>
                  );
                })}

                {queued.map((p, i) => (
                  <button
                    key={p.phase_id}
                    type="button"
                    className="wf-block wf-queued"
                    data-s="queued"
                    data-on={String(p.phase_id === selected)}
                    style={{ right: `${8 + i * 6}px`, width: 150 }}
                    title={`${p.name} — queued`}
                    onClick={() => setSelected(p.phase_id === selected ? null : p.phase_id)}
                  >
                    <span className="wf-b-top">
                      <span className="wf-b-mark" data-s="queued">
                        ○
                      </span>
                      <span className="wf-b-name">{p.name}</span>
                    </span>
                    <span className="wf-b-desc">queued</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {phase ? (
        <PhaseDetail
          phase={phase}
          agent={agents.find((a) => a.agent === phase.owner) ?? null}
          events={events.filter((e) => e.phase_id === phase.phase_id)}
          gates={gates.filter((g) => g.phase_id === phase.phase_id)}
          envelopes={envelopes.filter((e) => e.phase_id === phase.phase_id)}
          adwId={session.adw_id}
          now={now}
          onClose={() => setSelected(null)}
        />
      ) : (
        <div className="wf-hint">click a phase to open its breakdown</div>
      )}
    </>
  );
}

/**
 * The narrowest the track may be before the waterfall starts scrolling.
 *
 * Percentages alone cannot keep a block readable: a twenty-phase run divides
 * the same track twenty ways and every block becomes a sliver. So the track is
 * given a floor in pixels — enough for each phase to carry its name — and the
 * run scrolls sideways past it. The request zone is reserved space, so the
 * floor is grossed up by it.
 */
const BLOCK_MIN_PX = 104;

function trackMin(phases: PhaseRow[], zone: number): number {
  const timed = phases.filter((p) => p.started_at && p.kind !== "engineer").length;
  return Math.max(640, Math.round((timed * BLOCK_MIN_PX) / (1 - zone / 100)));
}

/**
 * A clock that only ticks while something is in flight.
 *
 * A finished run's geometry is fixed, and re-rendering it every second would
 * burn a frame to move nothing.
 */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}
