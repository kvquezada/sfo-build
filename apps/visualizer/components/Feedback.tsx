"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ago } from "@/lib/format.ts";

type Save = "clean" | "saving" | "error";

const SCORES = [1, 2, 3, 4, 5] as const;

/**
 * The reader's own judgement of a run: a 1-5 score and a note, editable forever
 * after the fact. Both write columns no tracer touches — see lib/db.ts's header.
 *
 * Behind a dialog rather than a panel because most runs are never judged, and a
 * fixture you scroll past on every one of them is not worth the vertical space
 * above the waterfall.
 *
 * SEEDED ON OPEN, THEN DEAF. `AutoRefresh` calls `router.refresh()` every ten
 * seconds on this page and replaces every server prop wholesale, so a note
 * driven by `props.note` would be yanked out from under the caret mid-sentence.
 * The draft is read from the server at the moment the dialog opens and ignored
 * until it closes — a poll can never touch what you are typing, and reopening
 * always shows what the server actually holds.
 *
 * A native <dialog>: Esc, the backdrop, focus containment and the top layer all
 * come from the platform. This codebase's only other client-side machinery is
 * `fetch` and `setInterval`, and a modal is not the thing to break that over.
 */
export function Feedback({
  adwId,
  rating: savedRating,
  note: savedNote,
  feedbackAt,
  live,
}: {
  adwId: string;
  rating: number | null;
  note: string | null;
  feedbackAt: string | null;
  live: boolean;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [rating, setRating] = useState<number | null>(savedRating);
  const [draft, setDraft] = useState(savedNote ?? "");
  const [save, setSave] = useState<Save>("clean");

  const dirty = rating !== savedRating || draft !== (savedNote ?? "");

  function open() {
    // The seed, and the only moment the server's copy is allowed to win.
    setRating(savedRating);
    setDraft(savedNote ?? "");
    setSave("clean");
    dialog.current?.showModal();
  }

  const close = useCallback(() => dialog.current?.close(), []);

  async function commit() {
    setSave("saving");
    try {
      const response = await fetch(`/api/sessions/${adwId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating, note: draft }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setSave("clean");
      close();
      // The opener and the list card both read off the same row.
      router.refresh();
    } catch {
      setSave("error");
    }
  }

  function score(value: number) {
    // Clicking the selected score clears it: a rating you can set but not
    // retract is one you hesitate to set at all.
    setRating(rating === value ? null : value);
  }

  return (
    <>
      <button
        type="button"
        className="rate-open"
        data-on={String(savedRating !== null || Boolean(savedNote))}
        onClick={open}
        title={openerTitle(savedRating, savedNote)}
      >
        <span aria-hidden="true">✎</span>
        {savedRating === null ? null : <span className="rate-open-score">{savedRating}/5</span>}
      </button>

      <dialog
        ref={dialog}
        className="rate-dialog"
        // `onCancel` is Esc and `onClose` is everything else; both land here, so
        // every way out of this dialog discards the draft identically.
        onClose={() => setSave("clean")}
      >
        <form method="dialog" className="rate-form" onSubmit={(e) => e.preventDefault()}>
          <h2>feedback</h2>
          <p className="rate-run">
            <span className="adwid">{adwId}</span>
          </p>

          <div className="rate-scale" role="group" aria-label="Rating, 1 to 5">
            {SCORES.map((value) => (
              <button
                key={value}
                type="button"
                className="rate-chip"
                data-on={String(rating === value)}
                onClick={() => score(value)}
                aria-pressed={rating === value}
              >
                {value}
              </button>
            ))}
            <span className="rate-scale-hint">
              {rating === null ? "unrated" : `${rating}/5`}
            </span>
          </div>

          {live ? (
            <p className="rate-hint">
              Still in flight — you can judge it now, but it is not done arguing.
            </p>
          ) : null}

          <textarea
            className="rate-note"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            maxLength={4000}
            placeholder="What was good, what was wrong, what you'd change in the prompt…"
            aria-label="Note about this run"
          />

          <div className="rate-foot">
            {/* `ago()` is relative to now, so the server's copy and the client's
                are computed a second apart and never agree. */}
            <span className="rate-state" data-s={save} suppressHydrationWarning>
              {stateLabel(save, feedbackAt)}
            </span>
            <span className="spacer" />
            <button type="button" className="rate-btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="rate-btn"
              data-primary="true"
              onClick={() => void commit()}
              disabled={!dirty || save === "saving"}
            >
              {save === "saving" ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function openerTitle(rating: number | null, note: string | null): string {
  if (rating === null && !note) return "Rate this run";
  const parts = [rating === null ? "Unrated" : `Rated ${rating}/5`];
  if (note) parts.push("has a note");
  return parts.join(" · ");
}

function stateLabel(save: Save, feedbackAt: string | null): string {
  if (save === "saving") return "saving…";
  if (save === "error") return "could not save";
  if (feedbackAt) return `saved · ${ago(feedbackAt)}`;
  return "";
}
