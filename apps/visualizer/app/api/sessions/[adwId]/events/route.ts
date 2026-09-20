import * as db from "@/lib/db.ts";
import { intParam, safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `?after=<rowid>` is the poll cursor. rowid rather than a timestamp because
 * several events routinely share a millisecond, and insertion order is the
 * order things actually happened in.
 */
export const GET = (request: Request, ctx: { params: Promise<{ adwId: string }> }) =>
  safely(async () => {
    const { adwId } = await ctx.params;
    return db.events(adwId, intParam(request, "after", 0), intParam(request, "limit", 500));
  });
