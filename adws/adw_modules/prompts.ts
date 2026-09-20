/** Prompt rendering: load system/user templates, replace {{placeholders}}. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
