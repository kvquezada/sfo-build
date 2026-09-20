/**
 * Waterfall geometry, and one bug in particular.
 *
 * `layout` used to advance a single cursor per phase, on the stated doctrine
 * that phases never overlap. When an ADW began running two agents at once, the
 * render kept the doctrine and dropped the truth: a concurrent pair was drawn
 * end to end, in a gap where nothing had happened. These pin the fix AND the
 * thing the fix must not disturb — a sequential run still lays out exactly as
 * it did.
 */

import { describe, expect, test } from "bun:test";

import { geometry } from "./trace.ts";
import type { PhaseRow, SessionRow } from "./db.ts";

const T0 = Date.parse("2026-09-20T18:43:46.000Z");
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();

const phase = (over: Partial<PhaseRow> & { phase_id: string }): PhaseRow => ({
  adw_id: "adw_t", seq: 1, name: over.phase_id, kind: "agent", owner: "agent",
  description: "", target: null, status: "success", attempt: 1, retries: 1,
  error: null, started_at: null, ended_at: null, ...over,
});

const session = (endSecs: number): SessionRow =>
  ({ adw_id: "adw_t", started_at: at(0), ended_at: at(endSecs), status: "success" }) as SessionRow;

/** The run that exposed this: build, then reviewer ‖ adversary, then commit. */
const concurrent = (): PhaseRow[] => [
  phase({ phase_id: "build", seq: 1, owner: "builder", started_at: at(0), ended_at: at(131) }),
  phase({ phase_id: "review", seq: 2, owner: "reviewer", started_at: at(131), ended_at: at(186) }),
  phase({ phase_id: "adversary", seq: 3, owner: "adversary", started_at: at(131), ended_at: at(212) }),
  phase({ phase_id: "commit", seq: 4, kind: "code", owner: "git", started_at: at(212), ended_at: at(212) }),
];

const right = (b: { left: number; width: number }) => b.left + b.width;

describe("layout with concurrent phases", () => {
  test("two phases that ran at once are drawn at once", () => {
    const { blocks } = geometry(session(212), concurrent(), T0);
    // They started within the same instant, so they start at the same x...
    expect(blocks["review"]!.left).toBeCloseTo(blocks["adversary"]!.left, 5);
    // ...and the longer one reaches further right. That is the overlap.
    expect(right(blocks["adversary"]!)).toBeGreaterThan(right(blocks["review"]!));
  });

  test("the phase after the pair starts no earlier than the pair ends", () => {
    const { blocks } = geometry(session(212), concurrent(), T0);
    expect(blocks["commit"]!.left).toBeGreaterThanOrEqual(right(blocks["adversary"]!) - 1e-9);
  });

  test("the pair occupies ONE slot, not two — the track is not double-spent", () => {
    const { blocks } = geometry(session(212), concurrent(), T0);
    const pairSpan = right(blocks["adversary"]!) - blocks["review"]!.left;
    const stacked = blocks["review"]!.width + blocks["adversary"]!.width;
    expect(pairSpan).toBeLessThan(stacked);
  });

  test("a staggered overlap keeps its stagger — same group, different x", () => {
    const rows = [
      phase({ phase_id: "a", seq: 1, started_at: at(0), ended_at: at(100) }),
      phase({ phase_id: "b", seq: 2, started_at: at(40), ended_at: at(140) }),
    ];
    const { blocks } = geometry(session(140), rows, T0);
    expect(blocks["b"]!.left).toBeGreaterThan(blocks["a"]!.left);
    expect(blocks["b"]!.left).toBeLessThan(right(blocks["a"]!)); // still overlapping
  });
});

describe("layout without concurrent phases", () => {
  const sequential = (): PhaseRow[] => [
    phase({ phase_id: "one", seq: 1, started_at: at(0), ended_at: at(60) }),
    phase({ phase_id: "two", seq: 2, started_at: at(70), ended_at: at(130) }),
    phase({ phase_id: "three", seq: 3, started_at: at(130), ended_at: at(190) }),
  ];

  test("blocks never stack, and the idle gap survives", () => {
    const { blocks } = geometry(session(190), sequential(), T0);
    expect(blocks["two"]!.left).toBeGreaterThan(right(blocks["one"]!));   // the 10s gap
    expect(blocks["three"]!.left).toBeCloseTo(right(blocks["two"]!), 5);  // back to back
  });

  test("a zero-length phase still renders at the floor", () => {
    const rows = [
      phase({ phase_id: "long", seq: 1, started_at: at(0), ended_at: at(300) }),
      phase({ phase_id: "instant", seq: 2, kind: "code", started_at: at(300), ended_at: at(300) }),
    ];
    const { blocks } = geometry(session(300), rows, T0);
    expect(blocks["instant"]!.width).toBeGreaterThanOrEqual(5.5);
  });

  test("a floored zero-length block does not fake concurrency with its neighbour", () => {
    const rows = [
      phase({ phase_id: "instant", seq: 1, kind: "code", started_at: at(0), ended_at: at(0) }),
      phase({ phase_id: "after", seq: 2, started_at: at(1), ended_at: at(120) }),
    ];
    const { blocks } = geometry(session(120), rows, T0);
    expect(blocks["after"]!.left).toBeGreaterThanOrEqual(right(blocks["instant"]!) - 1e-9);
  });

  test("everything stays inside the track", () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      phase({ phase_id: `p${i}`, seq: i + 1, started_at: at(i * 20), ended_at: at(i * 20 + 19) }),
    );
    const { blocks } = geometry(session(280), rows, T0);
    for (const b of Object.values(blocks)) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(right(b)).toBeLessThanOrEqual(100.5);
    }
  });
});
