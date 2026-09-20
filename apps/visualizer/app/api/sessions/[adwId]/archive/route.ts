import * as db from "@/lib/db.ts";
import { json, notFound, safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one write in the whole UI. Archiving is review triage — it belongs to the
 * reader, not to the run — which is why `archived` is the single column no
 * tracer ever touches.
 */
export const POST = (request: Request, ctx: { params: Promise<{ adwId: string }> }) =>
  safely(async () => {
    const { adwId } = await ctx.params;
    if (!db.isSafeSegment(adwId)) return json({ error: "invalid adw_id" }, 400);
    const body = (await request.json().catch(() => ({}))) as { archived?: unknown };
    const archived = body.archived === undefined ? true : Boolean(body.archived);
    return db.setArchived(adwId, archived)
      ? json({ adw_id: adwId, archived })
      : notFound(`no session ${adwId}`);
  });
