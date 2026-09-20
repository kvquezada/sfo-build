import { readFile } from "node:fs/promises";
import path from "node:path";

import * as db from "@/lib/db.ts";
import { json, notFound, safely } from "@/lib/respond.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The EXACT prompts an agent was sent, read from the session directory.
 *
 * Files are the raw record and the db has no copy of them, so this is the only
 * way to see what an agent was actually told — which is the first thing you
 * want when its output was surprising.
 */
export const GET = (
  _request: Request,
  ctx: { params: Promise<{ adwId: string; agent: string }> },
) =>
  safely(async () => {
    const { adwId, agent } = await ctx.params;
    if (!db.isSafeSegment(adwId) || !db.isSafeSegment(agent)) {
      return json({ error: "invalid adw_id or agent" }, 400);
    }
    if (!db.session(adwId)) return notFound(`no session ${adwId}`);

    const dir = path.resolve(db.SESSIONS_DIR, adwId, agent, "prompts");
    // Defence in depth: isSafeSegment already forbids traversal.
    if (dir !== db.SESSIONS_DIR && !dir.startsWith(db.SESSIONS_DIR + path.sep)) {
      return json({ error: "invalid path" }, 400);
    }

    // A prompt file is absent whenever the agent never ran in this session —
    // a normal state, so it reads as null rather than an error.
    const read = async (name: string): Promise<string | null> => {
      try {
        return await readFile(path.join(dir, `${name}.md`), "utf8");
      } catch {
        return null;
      }
    };
    return { system: await read("system"), user: await read("user") };
  });
