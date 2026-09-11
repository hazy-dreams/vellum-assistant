import { LookupPluginIngressRouteIpcParamsSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import {
  lookupPluginIngressRoute,
  resolvePluginIngress,
  type PluginIngressResolution,
} from "../channels/plugin-ingress-approvals.js";
import { ipcRoute, type IpcRoute } from "./server.js";

/** Read-only declaration lookup. Guardian approval writes stay on the HTTP API. */
export function createPluginIngressRoutes(
  resolve: () => PluginIngressResolution = resolvePluginIngress,
): IpcRoute[] {
  return [
    ipcRoute({
      method: "lookup_plugin_ingress_route",
      schema: LookupPluginIngressRouteIpcParamsSchema,
      handler: ({ plugin, path }) =>
        lookupPluginIngressRoute(resolve(), plugin, path),
    }),
  ];
}
