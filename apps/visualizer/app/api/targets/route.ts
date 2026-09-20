import * as db from "@/lib/db.ts";
import { safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Distinct targets with run counts — what the target filter is built from. */
export const GET = () => safely(() => db.targets());
