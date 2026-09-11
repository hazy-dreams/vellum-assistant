/** Filesystem handler resolution shared by runtime dispatch and gateway ingress policy. */
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Supported file extensions for handler modules (`.ts` preferred over `.js`). */
export const HANDLER_EXTENSIONS = [".ts", ".js"] as const;

/** Directory basename reserved for co-located tests: never a route segment. */
const TEST_DIR_NAME = "__tests__";

/**
 * True when a path under a routes directory is test machinery rather than a
 * servable handler: any `__tests__` segment, or a `*.test.ts` / `*.test.js`
 * filename. Discovery and dispatch both exclude these so a co-located test
 * file is never dynamically imported into the daemon: a test file's
 * top-level `mock.module(...)` calls are process-global and would replace
 * production modules (DB, platform paths) in the live process.
 */
export function isRouteTestPath(relPath: string): boolean {
  const segments = relPath.split(sep);
  return (
    segments.includes(TEST_DIR_NAME) ||
    /\.test\.(ts|js)$/.test(segments.at(-1) ?? "")
  );
}

/**
 * Resolve a sub-path within `routesDir` to a handler file on disk.
 *
 * Checks for direct file matches first (`<path>.ts`, `<path>.js`), then falls
 * back to index files (`<path>/index.ts`, `<path>/index.js`). Returns the
 * absolute path to the handler file, or `null` if not found. Rejects any path
 * that escapes `routesDir` (traversal backstop) and any test path
 * ({@link isRouteTestPath}), so test files are never served or imported.
 */
export function resolveHandlerFile(
  routesDir: string,
  subPath: string,
): string | null {
  const base = resolve(routesDir);
  const resolved = resolve(join(routesDir, subPath));

  if (!resolved.startsWith(base)) {
    return null;
  }

  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = `${resolved}${ext}`;
    if (existsSync(candidate) && !isRouteTestPath(relative(base, candidate))) {
      return candidate;
    }
  }

  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = join(resolved, `index${ext}`);
    if (existsSync(candidate) && !isRouteTestPath(relative(base, candidate))) {
      return candidate;
    }
  }

  return null;
}
