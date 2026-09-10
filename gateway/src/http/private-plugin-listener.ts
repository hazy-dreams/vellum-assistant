import { PLUGIN_WEBHOOK_PATH_PATTERN } from "../channels/plugin-ingress.js";

/** The caller supplies the private-context handler; no general router is mounted. */
export function startPrivatePluginListener(
  port: number | undefined,
  handle: (req: Request, plugin: string, path: string) => Promise<Response>,
) {
  if (port === undefined) {
    return undefined;
  }
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    maxRequestBodySize: 512 * 1024 * 1024,
    fetch(req) {
      const match = new URL(req.url).pathname.match(
        PLUGIN_WEBHOOK_PATH_PATTERN,
      );
      if (!match || req.headers.get("upgrade")) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return handle(req, match[1]!, match[2]!);
    },
  });
}
