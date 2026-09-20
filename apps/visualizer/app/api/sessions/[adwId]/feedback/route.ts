import * as db from "@/lib/db.ts";
import { json, notFound, safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A reader's rating and note on a run. Like archiving, this is review triage —
 * it belongs to whoever reads the trace, not to the run — so it writes only
 * columns no tracer ever touches.
 *
 * The body is a PATCH in POST's clothing: a key that is absent is left alone.
 */
const NOTE_MAX = 4000;

export const POST = (request: Request, ctx: { params: Promise<{ adwId: string }> }) =>
  safely(async () => {
    const { adwId } = await ctx.params;
    if (!db.isSafeSegment(adwId)) return json({ error: "invalid adw_id" }, 400);
    const body = (await request.json().catch(() => ({}))) as {
      rating?: unknown;
      note?: unknown;
    };

    const patch: { rating?: number | null; note?: string } = {};
    if ("rating" in body) {
      // null is a real value here — it is how a reader un-rates a run — so an
      // out-of-range score is rejected rather than folded into "unrated".
      if (body.rating === null) patch.rating = null;
      else if (
        typeof body.rating === "number" &&
        Number.isInteger(body.rating) &&
        body.rating >= 1 &&
        body.rating <= 5
      ) {
        patch.rating = body.rating;
      } else return json({ error: "rating must be an integer 1-5, or null" }, 400);
    }
    if ("note" in body) {
      if (typeof body.note !== "string") return json({ error: "note must be a string" }, 400);
      patch.note = body.note.slice(0, NOTE_MAX);
    }

    if (!db.setFeedback(adwId, patch)) return notFound(`no session ${adwId}`);
    const row = db.session(adwId);
    return json({
      adw_id: adwId,
      rating: row?.rating ?? null,
      note: row?.note ?? null,
      feedback_at: row?.feedback_at ?? null,
    });
  });
