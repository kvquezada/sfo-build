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

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
