"use client";

import Link from "next/link";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * The header trail, and the phase selection it ends with.
 *
 * The last crumb names the phase whose detail is open, and that selection is
 * client state owned by the waterfall — which sits far below the header in the
 * tree and cannot hand anything upward. So the selection is lifted here, into
 * a provider that wraps both, rather than duplicated: one selection, read by
 * the crumb and written by the lane a click lands on.
 */

interface Selection {
  phaseId: string | null;
  phaseName: string | null;
  select: (phase: { phase_id: string; name: string } | null) => void;
}

const SelectionContext = createContext<Selection>({
  phaseId: null,
  phaseName: null,
  select: () => {},
});

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<{ phase_id: string; name: string } | null>(null);
  const value = useMemo<Selection>(
    () => ({
      phaseId: phase?.phase_id ?? null,
      phaseName: phase?.name ?? null,
      select: setPhase,
    }),
    [phase],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): Selection {
  return useContext(SelectionContext);
}

/**
 * `adwId` absent means the list page, where the trail stops at "sessions" —
 * the crumb says where you are, so it never names a run you are not looking at.
 */
export function Breadcrumb({ adwId }: { adwId?: string }) {
  const { phaseName, select } = useSelection();
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {/* Separates the trail from the wordmark beside it, which is not itself
          a crumb — hence a slash rather than the chevron the trail uses. */}
      <span className="crumb-root-sep" aria-hidden="true">
        /
      </span>
      {adwId ? (
        <Link href="/" className="crumb-link">
          sessions
        </Link>
      ) : (
        <span className="crumb-here">sessions</span>
      )}
      {adwId ? (
        <>
          <span className="crumb-sep" aria-hidden="true">
            ›
          </span>
          {/* Not a Link: it points at the route already open, so navigating
              would change nothing. Going back UP the trail from a phase means
              closing that phase, which is a selection change, not a URL one. */}
          {phaseName ? (
            <button type="button" className="crumb-link crumb-up" onClick={() => select(null)}>
              {adwId}
            </button>
          ) : (
            <span className="crumb-here">{adwId}</span>
          )}
        </>
      ) : null}
      {adwId && phaseName ? (
        <>
          <span className="crumb-sep" aria-hidden="true">
            ›
          </span>
          <span className="crumb-here">{phaseName}</span>
        </>
      ) : null}
    </nav>
  );
}
