import * as db from "@/lib/db.ts";
import { intParam, safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  safely(() => {
    const params = new URL(request.url).searchParams;
    const archived = params.get("archived");
    return db.sessions({
      limit: intParam(request, "limit", 200),
      target: params.get("target") ?? undefined,
      archived: archived === null ? undefined : archived === "1" || archived === "true",
    });
  });
