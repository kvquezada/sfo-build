import * as db from "@/lib/db.ts";
import { safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () => safely(() => db.health());
