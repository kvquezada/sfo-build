/**
 * Shared response helpers.
 *
 * NOTE: `runtime` and `dynamic` are NOT exported from here. Next requires route
 * segment config to be a literal declaration inside each route file — a
 * re-export is not statically analysable, and the build fails on it. So every
 * route repeats the two lines; that duplication is the framework's price, not
 * an oversight.
 */
import { MissingDatabase } from "./db.ts";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function notFound(message: string): Response {
  return json({ error: message }, 404);
}

/** One place decides what an exception looks like to the client. */
export async function safely(fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const result = await fn();
    return result instanceof Response ? result : json(result);
  } catch (error) {
    if (error instanceof MissingDatabase) return json({ error: error.message }, 503);
    return json({ error: (error as Error).message ?? String(error) }, 500);
  }
}

export function intParam(request: Request, name: string, fallback: number): number {
  const raw = new URL(request.url).searchParams.get(name);
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
