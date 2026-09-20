import { num } from "@/lib/format.ts";

export function Status({ status }: { status: string }) {
  return (
    <span className="status" data-s={status}>
      {status}
    </span>
  );
}

/** The target badge. A flat registry means "which repo" is never implicit. */
export function TargetBadge({ target }: { target: string | null }) {
  if (!target) return null;
  return <span className="badge">{target}</span>;
}

export function PhaseDots({
  phases,
}: {
  phases: { total: number; success: number; fail: number; running: number };
}) {
  const dots: string[] = [
    ...Array<string>(phases.success).fill("success"),
    ...Array<string>(phases.running).fill("running"),
    ...Array<string>(phases.fail).fill("fail"),
  ];
  if (!dots.length) return null;
  return (
    <span className="dots" title={`${phases.success}/${phases.total} phases passed`}>
      {dots.slice(0, 24).map((s, i) => (
        <span key={i} className="dot" data-s={s} />
      ))}
    </span>
  );
}

/**
 * Spend, as the two numbers Copilot actually reports.
 *
 * There is deliberately no dollar figure: Copilot exposes none, and a single
 * invented total would be a guess wearing a decimal point.
 */
export function Spend({ premium, aiu }: { premium: number; aiu: number }) {
  return (
    <>
      <span title="premium requests">{num(premium)} prem</span>
      <span title="nano AIU">{num(aiu)} aiu</span>
    </>
  );
}
