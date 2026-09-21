/** Prompt rendering: load system/user templates, replace {{placeholders}}. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The brief for ONE target, or "" when it has none.
 *
 * Chosen per target rather than per run: on a cross-repo trace each phase
 * stands in a different checkout, and each gets its own repo's description.
 * A missing file is not an error and falls back to nothing — an empty brief
 * costs the agent a little orientation, a wrong one costs it the run.
 */
export function brief(promptRoot: string, target: { brief: string }): string {
  const file = path.join(promptRoot, "_briefs", `${target.brief}.md`);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

export function render(templatePath: string, variables: Record<string, string>): string {
  let text = readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(variables)) {
    text = text.split(`{{${key}}}`).join(value);
  }
  return text;
}

/** Save the exact prompt sent, BEFORE execution — the audit copy. */
export function save(directory: string, name: string, content: string): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, content);
  return file;
}
