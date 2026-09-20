export function ago(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return "";
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function clock(iso: string | null): string {
  return iso ? iso.slice(11, 23) : "";
}

export function num(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString();
}

/** Token counts in a lane label, where the column is too narrow for commas. */
export function compact(value: number | null | undefined): string {
  const n = value ?? 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Dollars, from the one Copilot number that is denominated in money.
 *
 * GitHub documents `totalNanoAiu` as the session's AI-credit COST in nano-AI
 * units, and prices an AI credit at $0.01 — so `nano_aiu / 1e9 / 100` is USD,
 * not an invented rate. It is still called an estimate in the UI because the
 * credit conversion belongs to Copilot billing rather than to the stream, and
 * GitHub's own SDK docs say to verify before showing currency.
 *
 * Premium requests are deliberately NOT priced here. They are the older
 * per-request unit, they only cost anything once a plan's monthly allowance is
 * gone, and multiplying them by the $0.04 overage rate would double-count the
 * same work the credits already charge for.
 */
const USD_PER_AI_CREDIT = 0.01;

export function credits(nanoAiu: number | null | undefined): number {
  return (nanoAiu ?? 0) / 1e9;
}

export function usd(nanoAiu: number | null | undefined): number {
  return credits(nanoAiu) * USD_PER_AI_CREDIT;
}

/** Runs land in cents, phases in fractions of one — three places keeps both real. */
export function money(nanoAiu: number | null | undefined): string {
  const value = usd(nanoAiu);
  if (!value) return "$0";
  if (value < 0.001) return "<$0.001";
  return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}
