import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigError, loadConfig, targetsPath } from "./config.ts";

let root: string;
let shared: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sfo-config-"));
  shared = path.join(root, "sfo.config.yaml");
  writeFileSync(shared, `defaults:\n  data_dir: ${root}\nagents: []\n`);
  delete process.env["SFO_TARGETS"];
});

afterEach(() => {
  delete process.env["SFO_TARGETS"];
  rmSync(root, { recursive: true, force: true });
});

describe("targets are per machine", () => {
  test("a fresh machine has no targets file, and no targets", () => {
    expect(loadConfig(shared).targets).toEqual([]);
  });

  test("rows come from <data_dir>/targets.yaml", () => {
    writeFileSync(
      path.join(root, "targets.yaml"),
      "targets:\n  - name: ios\n    path: ~/Workspace/ios\n",
    );
    const [row] = loadConfig(shared).targets;
    expect(row?.name).toBe("ios");
    expect(row?.test).toEqual([]);
  });

  test("$SFO_TARGETS overrides the location", () => {
    const elsewhere = path.join(root, "mine.yaml");
    writeFileSync(elsewhere, "targets:\n  - name: kb\n    path: ~/kb\n");
    process.env["SFO_TARGETS"] = elsewhere;
    expect(targetsPath(root)).toBe(elsewhere);
    expect(loadConfig(shared).targets.map((t) => t.name)).toEqual(["kb"]);
  });

  test("a targets: key in the shared config is refused, naming where rows go", () => {
    writeFileSync(shared, `defaults:\n  data_dir: ${root}\ntargets: []\n`);
    expect(() => loadConfig(shared)).toThrow(ConfigError);
    expect(() => loadConfig(shared)).toThrow(path.join(root, "targets.yaml"));
  });

  test("a bad row is reported against the targets file, not the shared config", () => {
    writeFileSync(path.join(root, "targets.yaml"), "targets:\n  - name: ios\n");
    expect(() => loadConfig(shared)).toThrow(`invalid targets ${path.join(root, "targets.yaml")}`);
  });
});
