import Link from "next/link";

/**
 * Plain links, not a client component. The filter is a URL, so it survives a
 * reload, is shareable, and needs no JavaScript to work.
 */
export function TargetFilter({
  targets,
  active,
}: {
  targets: { target: string; runs: number }[];
  active: string | null;
}) {
  if (!targets.length) return null;
  return (
    <div className="filters">
      <Link href="/" className="chip" data-on={String(!active)}>
        all
        <span className="count">{targets.reduce((n, t) => n + t.runs, 0)}</span>
      </Link>
      {targets.map((t) => (
        <Link
          key={t.target}
          href={`/?target=${encodeURIComponent(t.target)}`}
          className="chip"
          data-on={String(active === t.target)}
        >
          {t.target}
          <span className="count">{t.runs}</span>
        </Link>
      ))}
    </div>
  );
}
