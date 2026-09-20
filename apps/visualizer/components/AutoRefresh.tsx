"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Poll, never push. The whole trace pipeline is agents → sqlite → reader, and
 * adding a socket would be a second source of truth for no benefit: SQLite in
 * WAL mode is already safe to read while a run writes.
 *
 * Two cadences, because "nothing is in flight" is not the same as "nothing will
 * be": a list left open on an idle factory still has to notice the run that
 * starts a minute later, and a run joined by a later ADW (`--adw-id`) goes back
 * to running after it was already success. So the poll never stops — it only
 * slows down, and the badge is what says whether work is actually in flight.
 */
export function AutoRefresh({
  active,
  ms = 1500,
  idleMs = 5000,
}: {
  active: boolean;
  ms?: number;
  idleMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), active ? ms : idleMs);
    return () => clearInterval(id);
  }, [active, ms, idleMs, router]);

  if (!active) return null;
  return <span className="live">live</span>;
}
