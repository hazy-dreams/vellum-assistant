import { posix } from "node:path";

import { discoverPluginIngress } from "../channels/plugin-ingress.js";

/** Blocks the general proxy's aliases of a private handler, including index files. */
export function isPrivatePluginRuntimePath(pathname: string): boolean {
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
  const handlerPath = (value: string) =>
    value.replace(/\/$/, "").replace(/(?:^|\/)index$/, "");
  const requested = handlerPath(match[2] ?? "");
  const discovery = discoverPluginIngress();
  if (discovery.problems.some((problem) => problem.plugin === plugin)) {
    return true;
  }
  return discovery.plugins.some(
    (declaration) =>
      declaration.plugin === plugin &&
      declaration.routes.some(
        (route) =>
          route.exposure === "private" && handlerPath(route.path) === requested,
      ),
  );
}
