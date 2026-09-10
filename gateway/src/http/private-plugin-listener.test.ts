import { afterEach, describe, expect, it } from "bun:test";

import { startPrivatePluginListener } from "./private-plugin-listener.js";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("private plugin listener", () => {
  const handler = async (_req: Request, plugin: string, path: string) =>
    Response.json({ plugin, path });

  it("stays disabled when no port is configured", () => {
    expect(startPrivatePluginListener(undefined, handler)).toBeUndefined();
  });

  it("binds loopback and exposes only plugin webhooks", async () => {
    const server = startPrivatePluginListener(0, handler)!;
    servers.push(server);
    expect(server.hostname).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;
    expect(
      await (
        await fetch(`${base}/webhooks/plugins/example-plugin/events`)
      ).json(),
    ).toEqual({ plugin: "example-plugin", path: "events" });
    for (const path of [
      "/healthz",
      "/v1/config",
      "/v1/x/plugins/example-plugin/events",
      "/x/plugins/example-plugin/events",
    ]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });

  it("throws on bind failure without selecting another address", () => {
    const server = startPrivatePluginListener(0, handler)!;
    servers.push(server);
    expect(() => startPrivatePluginListener(server.port!, handler)).toThrow();
  });
});
