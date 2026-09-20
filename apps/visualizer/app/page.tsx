import Link from "next/link";

import * as db from "@/lib/db.ts";
import { ago, clip, num } from "@/lib/format.ts";
import { AutoRefresh } from "@/components/AutoRefresh.tsx";
import { PhaseDots, Spend, Status, TargetBadge } from "@/components/chips.tsx";
import { TargetFilter } from "@/components/TargetFilter.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ target?: string }>;
}) {
  const { target } = await searchParams;

  let rows: ReturnType<typeof db.sessions>;
  let targets: { target: string; runs: number }[];
  let info: ReturnType<typeof db.health>;
  try {
    rows = db.sessions({ target, limit: 200 });
    targets = db.targets();
    info = db.health();
  } catch (error) {
    return (
      <>
        <Masthead />
        <main className="shell">
          <div className="err">{(error as Error).message}</div>
        </main>
      </>
    );
  }

  const live = rows.some((r) => r.status === "running");

  return (
    <>
      <Masthead db={info.db} live={live} />
      <main className="shell">
        <TargetFilter targets={targets} active={target ?? null} />
        <div style={{ height: 18 }} />
        {rows.length === 0 ? (
          <p className="empty">
            No runs{target ? ` for target “${target}”` : ""} yet.
            <br />
            <span className="mono" style={{ fontSize: 12 }}>
              npm run scout -- --target oms &quot;what is this repo&quot;
            </span>
          </p>
        ) : (
          <div className="cards">
            {rows.map((row) => (
              <Link key={row.adw_id} href={`/sessions/${row.adw_id}`} className="card">
                <div className="card-top">
                  <span className="adwid">{row.adw_id}</span>
                  <Status status={row.status} />
                  <TargetBadge target={row.target} />
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                    {row.adw_name}
                  </span>
                  <span style={{ flex: 1 }} />
                  <PhaseDots phases={row.phases} />
                </div>
                {row.request ? <div className="request">{clip(row.request, 160)}</div> : null}
                <div className="card-foot">
                  <span>{ago(row.started_at)}</span>
                  <span>
                    {row.phases.success}/{row.phases.total} phases
                  </span>
                  <Spend premium={row.premium_requests} aiu={row.nano_aiu} />
                  <span>{num(row.total_tokens)} tok</span>
                  {row.engineer ? <span>{row.engineer}</span> : null}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function Masthead({ db: dbPath, live }: { db?: string; live?: boolean }) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <span className="brand">
          sfo-build <span>/ trace</span>
        </span>
        <AutoRefresh active={Boolean(live)} />
        <span className="spacer" />
        {dbPath ? <span className="dbline">{dbPath}</span> : null}
      </div>
    </header>
  );
}
