import { existsSync } from "node:fs";
import { join, posix } from "node:path";

import { resolveHandlerFile } from "@vellumai/service-contracts/route-handler";

import {
  resolvePluginIngress,
  type PluginIngressResolution,
} from "../channels/plugin-ingress-approvals.js";
import { getWorkspaceDir } from "../paths.js";

/** Blocks the general proxy's aliases of a private handler, including index files. */
export function isPrivatePluginRuntimePath(
  pathname: string,
  resolve: () => PluginIngressResolution = resolvePluginIngress,
): boolean {
  let path: string;
  try {
    path = posix.normalize(decodeURIComponent(pathname));
  } catch {
    return true;
  }
  const match = path.match(
    /^\/(?:v1\/(?:assistants\/[^/]+\/)?)?x\/plugins\/([^/]+)(?:\/(.*))?$/,
  );
  if (!match) {
    return false;
  }
  const plugin = match[1]!;
  const resolution = resolve();
  if (resolution.problems.some((problem) => problem.plugin === plugin)) {
    return true;
  }
  const privateRoutes = [...resolution.approved, ...resolution.pending]
    .filter((declaration) => declaration.plugin === plugin)
    .flatMap((declaration) => declaration.routes)
    .filter((route) => route.exposure === "private");
  if (privateRoutes.length === 0) {
    return false;
  }
  const routesDir = join(getWorkspaceDir(), "plugins", plugin, "routes");
  // Runtime may fall back to bundled routes that the gateway cannot inspect.
  if (!existsSync(routesDir)) {
    return true;
  }
  const requested = resolveHandlerFile(routesDir, match[2] ?? "");
  if (!requested) {
    return false;
  }
  return privateRoutes.some(
    (route) => resolveHandlerFile(routesDir, route.path) === requested,
  );
}