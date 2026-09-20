import { credits, money, num } from "@/lib/format.ts";

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
 * Spend, led by the dollar figure.
 *
 * Copilot exposes no `total_cost` field, but `nano_aiu` IS money: GitHub
 * documents it as the run's AI-credit cost and prices a credit at $0.01. The
 * dollars are converted, not invented, so they lead and the raw units follow
 * for anyone reconciling against a Copilot bill.
 */
export function Spend({ premium, aiu }: { premium: number; aiu: number }) {
  return (
    <>
      <span title={`${credits(aiu).toFixed(2)} AI credits at $0.01 each`}>{money(aiu)}</span>
      <span title="premium requests">{num(premium)} prem</span>
    </>
  );
}

/**
 * A run the reader has judged. Deliberately inert: the whole card is a `<Link>`,
 * so a button in here would spend its life cancelling navigation. Rating
 * happens on the run's own page, where the note is too.
 */
export function Rating({ rating, note }: { rating: number | null; note: string | null }) {
  if (rating === null && !note) return null;
  return (
    <span className="rating">
      {rating === null ? null : <span>{rating}/5</span>}
      {note ? (
        <span className="rating-note" title={note.split("\n")[0]} aria-label="has a note">
          ✎
        </span>
      ) : null}
    </span>
  );
}
