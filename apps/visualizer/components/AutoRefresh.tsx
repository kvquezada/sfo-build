"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Poll, never push. The whole trace pipeline is agents → sqlite → reader, and
 * adding a socket would be a second source of truth for no benefit: SQLite in
 * WAL mode is already safe to read while a run writes.
 *
 * Only polls while something is actually in flight — a finished run's page is
 * static, and re-fetching it forever is just noise on the terminal.
 */
export function AutoRefresh({ active, ms = 1500 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), ms);
    return () => clearInterval(id);
  }, [active, ms, router]);

  if (!active) return null;
  return <span className="live">live</span>;
}
