import Link from "next/link";
import { notFound } from "next/navigation";

import * as db from "@/lib/db.ts";
import { ago, clock, credits, duration, money, num } from "@/lib/format.ts";
import { eventLabel } from "@/lib/trace.ts";
import { AutoRefresh } from "@/components/AutoRefresh.tsx";
import { Status, TargetBadge } from "@/components/chips.tsx";
import { Waterfall } from "@/components/Waterfall.tsx";

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
  // A chained run (`--adw-id`) goes running → success → running as the next ADW
  // joins it, so "not running right now" is not "finished forever". The page
  // keeps a slow pulse either way; only the cadence changes.
  const live = session.status === "running";

  // Events belonging to the run rather than to any phase. Everything else is
  // reachable through its phase's block, so this is the only list left: it
  // exists so that dropping the flat log hides nothing.
  const loose = events.filter((e) => !e.phase_id);

  return (
    <>
      <header className="masthead masthead-wide">
        <div className="masthead-inner">
          <span className="brand">
            sfo-build <span>/ trace</span>
          </span>
          <AutoRefresh active={live} idleMs={10_000} />
          <span className="spacer" />
          <span className="dbline">{db.DB_PATH}</span>
        </div>
      </header>

      <main className="shell shell-wide">
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
              {session.started_at}{" "}
              <span style={{ color: "var(--text-faint)" }}>({ago(session.started_at)})</span>
            </dd>
            <dt>elapsed</dt>
            <dd>{duration(session.started_at, session.ended_at) || "—"}</dd>
            <dt>spend</dt>
            <dd>
              <span title="AI credits billed by Copilot, at $0.01 per credit">
                {money(session.nano_aiu)} est.
              </span>
              <span style={{ color: "var(--text-faint)" }}>
                {"  ·  "}
                {credits(session.nano_aiu).toFixed(2)} AI credits{"  ·  "}
                {num(session.premium_requests)} premium req{"  ·  "}
                {num(session.total_tokens)} prompt tokens
              </span>
            </dd>
          </dl>
        </div>

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

        <Waterfall
          session={session}
          phases={phases}
          agents={agents}
          events={events}
          gates={gates}
          envelopes={envelopes}
        />

        {loose.length ? (
          <div className="panel">
            <h2>run events · {loose.length}</h2>
            <div className="events">
              {loose.map((event) => (
                <div key={event.event_id} className="ev" data-t={event.type}>
                  <span className="ev-time">{clock(event.started_at)}</span>
                  <span className="ev-type">{event.type}</span>
                  <span className="ev-body">{eventLabel(event)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}
