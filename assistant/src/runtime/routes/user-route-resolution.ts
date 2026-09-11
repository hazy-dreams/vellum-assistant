/**
 * Shared path resolution for `/x/*` user routes.
 *
 * Both the request dispatcher (`user-route-dispatcher.ts`) and the CLI
 * discovery surface (`user-routes-cli.ts`) resolve `/x/` paths to on-disk
 * handler files through this module, so what the CLI lists can never drift
 * from what the dispatcher actually serves.
 *
 * Three locations back the surface:
 * - `<workspaceDir>/routes/<path>` — workspace routes, served at `/x/<path>`.
 * - `<workspaceDir>/plugins/<name>/routes/<path>` — an installed plugin's
 *   routes, served in that plugin's reserved namespace at
 *   `/x/plugins/<name>/<path>`.
 * - `plugins/defaults/<name>/routes/<path>` (the app source tree) — a
 *   first-party default plugin's routes, served in the same
 *   `/x/plugins/<name>/<path>` namespace, where `<name>` is the plugin's
 *   `default-…` manifest name (e.g. `default-platform-hosted`) — the same name
 *   its `.disabled` sentinel is keyed by. Default plugins live in the binary's
 *   source, not the workspace, so their routes resolve from the source tree.
 *   An installed plugin of the same name takes precedence (it can override a
 *   default).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  getDefaultPluginRouteRoots,
  getDefaultPluginRoutesDir,
} from "../../plugins/defaults/main.js";
import { isPluginDisabled } from "../../plugins/disabled-state.js";
import {
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
} from "../../util/platform.js";

export {
  HANDLER_EXTENSIONS,
  isRouteTestPath,
  resolveHandlerFile,
} from "@vellumai/service-contracts/route-handler";

/** Path segment reserved for plugin-namespaced routes under `/x/`. */
export const PLUGIN_ROUTE_SEGMENT = "plugins";

export interface RouteLocation {
  /** Absolute directory the handler file is resolved under. */
  routesDir: string;
  /** Path within `routesDir`, relative and without the `/x/` prefix. */
  subPath: string;
}

/**
 * The manifest name of the plugin whose namespace an `/x/` route path falls in,
 * or undefined for a workspace route.
 *
 * The dispatcher marks that plugin as in context for the handler's execution,
 * so host APIs a route handler reaches (`resolveCredential`,
 * `indexDocument`) scope to the owning plugin exactly as they do inside its
 * hooks and tools.
 */
export function pluginNameForRoutePath(routePath: string): string | undefined {
  const segments = routePath.split("/");
  if (segments[0] !== PLUGIN_ROUTE_SEGMENT) {
    return undefined;
  }
  return segments[1] || undefined;
}

/**
 * Resolve an `/x/` route path to the base directory + sub-path the handler file
 * is looked up under.
 *
 * `plugins/<name>/<rest>` resolves against that plugin's own `routes/`
 * directory (`<rest>` may be empty, mapping to the namespace's `index`
 * handler): an installed plugin's `<workspaceDir>/plugins/<name>/routes/` when
 * it ships one, otherwise a first-party default plugin's
 * `plugins/defaults/<name>/routes/` in the source tree. Everything else
 * resolves against the workspace `routes/` directory. Returns `null` (caller
 * 404s) when:
 *
 * - the path is a malformed plugin path (`plugins` with no name segment), so it
 *   never falls back to a workspace route — the `plugins/` prefix is reserved
 *   for plugin routes; or
 * - the named plugin is disabled (`.disabled` sentinel present), so a disabled
 *   plugin serves no routes even though its files remain on disk.
 */
export function resolveRouteLocation(routePath: string): RouteLocation | null {
  const segments = routePath.split("/");
  if (segments[0] === PLUGIN_ROUTE_SEGMENT) {
    const pluginName = pluginNameForRoutePath(routePath);
    if (!pluginName) {
      return null;
    }
    // A default plugin's namespace IS its `default-…` manifest name, so the
    // single `.disabled` sentinel key (`<workspace>/plugins/<name>/.disabled`)
    // covers installed and default plugins alike.
    if (isPluginDisabled(pluginName)) {
      return null;
    }
    return {
      routesDir: resolvePluginRoutesDir(pluginName),
      subPath: segments.slice(2).join("/"),
    };
  }
  return { routesDir: getWorkspaceRoutesDir(), subPath: routePath };
}

/**
 * Resolve the `routes/` directory that backs a plugin's `/x/plugins/<name>/`
 * namespace. An installed plugin that ships a `routes/` directory takes
 * precedence (so it can override a same-named default); otherwise a default
 * plugin's source `routes/` directory is used (resolved by manifest name).
 * Falls back to the (missing) workspace path when the name matches neither, so
 * {@link resolveHandlerFile} reports a 404.
 */
function resolvePluginRoutesDir(pluginName: string): string {
  const workspaceRoutesDir = join(
    getWorkspacePluginsDir(),
    pluginName,
    "routes",
  );
  if (existsSync(workspaceRoutesDir)) {
    return workspaceRoutesDir;
  }
  const defaultRoutesDir = getDefaultPluginRoutesDir(pluginName);
  if (defaultRoutesDir && existsSync(defaultRoutesDir)) {
    return defaultRoutesDir;
  }
  return workspaceRoutesDir;
}

/**
 * True when a workspace `/x/<path>` collides with the reserved plugin prefix
 * (`plugins` or `plugins/…`). Such a file lives under `<workspaceDir>/routes/`
 * but is shadowed by the plugin namespace and never served, so discovery must
 * exclude it — {@link resolveRouteLocation} routes the same path to a plugin
 * directory instead.
 */
export function isReservedWorkspaceRoutePath(routePath: string): boolean {
  return (
    routePath === PLUGIN_ROUTE_SEGMENT ||
    routePath.startsWith(`${PLUGIN_ROUTE_SEGMENT}/`)
  );
}

/**
 * Enumerate enabled plugins that ship a `routes/` directory, for route
 * discovery. Mirrors {@link resolveRouteLocation}'s plugin resolution — same
 * directories, same disabled-sentinel gate, same installed-over-default
 * precedence — so discovery and dispatch agree on which plugin routes exist.
 *
 * Default plugins are seeded first (lower precedence); an installed plugin of
 * the same name that ships routes overrides its entry.
 */
export function listPluginRouteRoots(): {
  pluginName: string;
  routesDir: string;
}[] {
  const byName = new Map<string, string>();

  for (const { pluginName, routesDir } of getDefaultPluginRouteRoots()) {
    if (!isPluginDisabled(pluginName)) {
      byName.set(pluginName, routesDir);
    }
  }

  const pluginsDir = getWorkspacePluginsDir();
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || isPluginDisabled(entry.name)) {
        continue;
      }
      const routesDir = join(pluginsDir, entry.name, "routes");
      if (existsSync(routesDir) && statSync(routesDir).isDirectory()) {
        byName.set(entry.name, routesDir);
      }
    }
  }

  return [...byName].map(([pluginName, routesDir]) => ({
    pluginName,
    routesDir,
  }));
}
