import Link from "next/link";
import { notFound } from "next/navigation";

import * as db from "@/lib/db.ts";
import { ago, clip, clock, duration, num } from "@/lib/format.ts";
import { AutoRefresh } from "@/components/AutoRefresh.tsx";
import { Spend, Status, TargetBadge } from "@/components/chips.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ adwId: string }>;
}) {
  const { adwId } = await params;
  if (!db.isSafeSegment(adwId)) notFound();

  const detail = db.sessionDetail(adwId);
  if (!detail) notFound();

  const { session, phases, agents, processes } = detail;
  const gates = db.gates(adwId);
  const envelopes = db.envelopes(adwId);
  const events = db.events(adwId, 0, 2000);
  const live = session.status === "running";

  const gatesByPhase = new Map<string, typeof gates>();
  for (const gate of gates) {
    const list = gatesByPhase.get(gate.phase_id) ?? [];
    list.push(gate);
    gatesByPhase.set(gate.phase_id, list);
  }
  const colorOf = new Map(agents.map((a) => [a.agent, a.color || "#8b94a8"]));

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <span className="brand">
            sfo-build <span>/ trace</span>
          </span>
          {live ? <AutoRefresh active /> : null}
          <span className="spacer" />
          <span className="dbline">{db.DB_PATH}</span>
        </div>
      </header>

      <main className="shell">
        <div className="crumb">
          <Link href="/">← all runs</Link>
          {session.target ? (
            <>
              {"  ·  "}
              <Link href={`/?target=${encodeURIComponent(session.target)}`}>{session.target}</Link>
            </>
          ) : null}
          {"  ·  "}
          {session.adw_id}
        </div>

        <div className="panel">
          <div className="card-top" style={{ marginBottom: 12 }}>
            <span className="adwid" style={{ fontSize: 15 }}>
              {session.adw_id}
            </span>
            <Status status={session.status} />
            <TargetBadge target={session.target} />
            <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
              {session.adw_name}
            </span>
          </div>
          {session.request ? (
            <p className="request" style={{ marginTop: 0 }}>
              {session.request}
            </p>
          ) : null}
          <dl className="kv">
            <dt>repo</dt>
            <dd>{session.repo_path}</dd>
            <dt>engineer</dt>
            <dd>{session.engineer}</dd>
            <dt>started</dt>
            <dd>
              {session.started_at} <span style={{ color: "var(--text-faint)" }}>({ago(session.started_at)})</span>
            </dd>
            <dt>elapsed</dt>
            <dd>{duration(session.started_at, session.ended_at) || "—"}</dd>
            <dt>spend</dt>
            <dd>
              {num(session.premium_requests)} premium · {num(session.nano_aiu)} nanoAIU ·{" "}
              {num(session.total_tokens)} prompt tokens
            </dd>
          </dl>
        </div>

        {agents.length ? (
          <div className="panel">
            <h2>agents</h2>
            <div className="agents">
              {agents.map((agent) => {
                const tools = agent.tools_json ? (JSON.parse(agent.tools_json) as string[]) : [];
                return (
                  <div key={agent.agent} className="agent-row">
                    <span className="swatch" style={{ background: agent.color || "#8b94a8" }} />
                    <span className="agent-name">{agent.agent}</span>
                    <span className="agent-model">{agent.model}</span>
                    <span className="agent-ctx">
                      {num(agent.context_tokens)} ctx
                      {/* No ceiling is shown because none exists: --context is a
                          tier, not a number, and no catalog exposes a window. */}
                      {agent.context_window ? ` / ${num(agent.context_window)}` : ""}
                    </span>
                    <span className="agent-ctx">{tools.length} tools</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {processes.length ? (
          <div className="panel">
            <h2>live processes</h2>
            <div className="events">
              {processes.map((p) => (
                <div key={p.id} className="ev">
                  <span className="ev-time">pid {p.pid}</span>
                  <span className="ev-type">{p.kind}</span>
                  <span className="ev-body">{p.command}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="panel">
          <h2>phases</h2>
          {phases.map((phase) => {
            const phaseGates = gatesByPhase.get(phase.phase_id) ?? [];
            const envelope = envelopes.find((e) => e.phase_id === phase.phase_id && e.valid);
            return (
              <div key={phase.phase_id} className="phase" data-kind={phase.kind}>
                <span className="phase-seq">{String(phase.seq).padStart(2, "0")}</span>
                <div className="phase-body">
                  <div className="phase-name" style={{ color: colorOf.get(phase.owner) ?? undefined }}>
                    {phase.name}
                  </div>
                  <div className="phase-desc">{phase.description}</div>
                  <div className="phase-meta">
                    <span>{phase.kind}</span>
                    <span>{phase.owner}</span>
                    <span>{duration(phase.started_at, phase.ended_at)}</span>
                    {phase.attempt > 0 ? <span>attempt {phase.attempt + 1}</span> : null}
                    {envelope ? <span>{envelope.output_type}</span> : null}
                  </div>

                  {phaseGates.map((gate) => {
                    const checks = JSON.parse(gate.checks_json) as {
                      item: string;
                      ok: boolean;
                      note: string;
                    }[];
                    return (
                      <div key={gate.id} className="gate">
                        <div className="gate-head">
                          <span style={{ color: gate.passed ? "var(--success)" : "var(--fail)" }}>
                            {gate.passed ? "✓" : "✗"}
                          </span>
                          <span>{gate.gate}</span>
                          <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
                            {checks.length} checked
                          </span>
                        </div>
                        {checks.map((check, i) => (
                          <div key={i} className="check" data-ok={String(check.ok)}>
                            <span className="item">{check.item}</span>
                            {check.note ? <span>— {clip(check.note, 180)}</span> : null}
                          </div>
                        ))}
                      </div>
                    );
                  })}

                  {phase.error ? <div className="phase-error">{phase.error}</div> : null}
                </div>
                <Status status={phase.status} />
              </div>
            );
          })}
        </div>

        <div className="panel">
          <h2>events · {events.length}</h2>
          <div className="events">
            {events.map((event) => (
              <div key={event.event_id} className="ev" data-t={event.type}>
                <span className="ev-time">{clock(event.started_at)}</span>
                <span className="ev-type">{event.type}</span>
                <span className="ev-body">{describe(event)}</span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}

/** One line per event. `log` events already carry the console's own sentence. */
function describe(event: { type: string; name: string; payload_json: string }): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payload_json) as Record<string, unknown>;
  } catch {
    return event.name;
  }
  if (event.type === "log" && typeof payload["message"] === "string") {
    return clip(payload["message"], 220);
  }
  if (event.type === "error" && typeof payload["error"] === "string") {
    return clip(payload["error"], 220);
  }
  if (event.type === "gate_fail" && Array.isArray(payload["violations"])) {
    return `${event.name}: ${clip((payload["violations"] as string[]).join("; "), 200)}`;
  }
  return clip(event.name, 220);
}
