/**
 * The two rules that are enforced by construction rather than by review:
 * hard rule 7 (a phase must have a real description) and the neutral tool
 * vocabulary (an unmapped name is a hard failure, never a silent drop).
 */

import { describe, expect, test } from "bun:test";

import { PhaseParams } from "./types.ts";
import { resolveTools, unsupported, UnknownToolError } from "./tool_map.ts";
import { agentSessionId, uuidv5, formatZodError } from "./utils.ts";

describe("PhaseParams.description", () => {
  const base = { name: "commit_plan", kind: "code", owner: "git" } as const;

  test("a real description is accepted and whitespace-normalized", () => {
    const parsed = PhaseParams.parse({
      ...base,
      description: "  Put the spec on record\n  before any code exists to blur it ",
    });
    expect(parsed.description).toBe("Put the spec on record before any code exists to blur it");
  });

  test("a blank description is refused", () => {
    expect(() => PhaseParams.parse({ ...base, description: "   " })).toThrow(/description is required/);
  });

  test("a description that only restates the name is refused", () => {
    // The whole failure this rule exists for: `commit_plan: "Commit the plan"`
    // tells a reader nothing the phase name did not already say.
    expect(() => PhaseParams.parse({ ...base, description: "Commit plan" })).toThrow(/only restates/);
    expect(() => PhaseParams.parse({ ...base, description: "commit plan." })).toThrow(/only restates/);
  });

  test("retries default to zero — a phase does not get a second chance by accident", () => {
    expect(PhaseParams.parse({ ...base, description: "Land the reviewed code" }).retries).toBe(0);
  });
});

describe("tool_map", () => {
  test("null means every tool the CLI has", () => {
    expect(resolveTools("copilot", null)).toBeNull();
  });

  test("a neutral name expands to every vendor tool it needs", () => {
    // `shell` without read_bash/stop_bash gives an agent a way to start a
    // background command and no way to read or kill it.
    const tools = resolveTools("copilot", ["shell"]);
    expect(tools).toEqual(["bash", "read_bash", "list_bash", "stop_bash"]);
  });

  test("names map to the MEASURED Copilot vocabulary, not the obvious guess", () => {
    expect(resolveTools("copilot", ["read"])).toEqual(["view"]);
    expect(resolveTools("copilot", ["write"])).toEqual(["create"]);
  });

  test("an unknown name is a hard failure, never a silent drop", () => {
    expect(() => resolveTools("copilot", ["telepathy"])).toThrow(UnknownToolError);
    expect(() => resolveTools("copilot", ["rg"])).toThrow(/neutral vocabulary/);
  });

  test("tools_extra rides through verbatim", () => {
    expect(resolveTools("copilot", ["read"], ["github-mcp-server-search_code"])).toEqual([
      "view",
      "github-mcp-server-search_code",
    ]);
  });

  test("duplicates collapse", () => {
    expect(resolveTools("copilot", ["read"], ["view"])).toEqual(["view"]);
  });

  test("a name with no equivalent on a vendor is reported, not dropped", () => {
    expect(unsupported("claude", ["sql"])).toEqual(["sql"]);
    expect(unsupported("copilot", ["sql"])).toEqual([]);
  });
});

describe("session ids", () => {
  test("are real UUIDs — both CLIs reject anything else", () => {
    // SSSF's `sssf-{adw_id}-{agent}-{rand}` is simply not a UUID.
    expect(agentSessionId("a1b2c3d4", "builder")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("are deterministic, so a later process rejoins the same context window", () => {
    expect(agentSessionId("a1b2c3d4", "builder")).toBe(agentSessionId("a1b2c3d4", "builder"));
  });

  test("differ per agent and per run", () => {
    expect(agentSessionId("a1b2c3d4", "builder")).not.toBe(agentSessionId("a1b2c3d4", "planner"));
    expect(agentSessionId("a1b2c3d4", "builder")).not.toBe(agentSessionId("zzzzzzzz", "builder"));
  });

  test("match the RFC 4122 v5 vector", () => {
    expect(uuidv5("www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
});

describe("formatZodError", () => {
  test("names the field, which is what the correction turn has to say", () => {
    const result = PhaseParams.safeParse({ name: "x", kind: "nope", owner: "g", description: "d" });
    expect(result.success).toBe(false);
    if (!result.success) expect(formatZodError(result.error)).toContain("kind");
  });
});
