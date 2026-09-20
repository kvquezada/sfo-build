import * as db from "@/lib/db.ts";
import { safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (_request: Request, ctx: { params: Promise<{ adwId: string }> }) =>
  safely(async () => db.gates((await ctx.params).adwId));
