import * as db from "@/lib/db.ts";
import { notFound, safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (_request: Request, ctx: { params: Promise<{ adwId: string }> }) =>
  safely(async () => {
    const { adwId } = await ctx.params;
    const detail = db.sessionDetail(adwId);
    return detail ?? notFound(`no session ${adwId}`);
  });
