/**
 * Node runtime, not Edge, and that is not negotiable: every route reads
 * `node:sqlite`, which does not exist on Edge.
 *
 * The engine lives OUTSIDE this app (../../adws/adw_modules), and the UI
 * imports its types from there on purpose — SSSF kept a second copy in the
 * visualizer's own `shared/types.ts` and the two drifted. One definition.
 */
const config = {
  typedRoutes: false,
  // Let the compiler follow imports above this directory into the engine.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  serverExternalPackages: ["node:sqlite"],
  eslint: { ignoreDuringBuilds: true },
};

export default config;
