import { describe, expect, it } from "bun:test";

import type { PluginIngressResolution } from "../channels/plugin-ingress-approvals.js";
import { parsePluginIngressManifest } from "../channels/plugin-ingress.js";
import { createPluginIngressRoutes } from "./plugin-ingress-handlers.js";

describe("lookup_plugin_ingress_route", () => {
  const routes = parsePluginIngressManifest({
    routes: [
      {
        path: "private-events",
        kind: "http",
        exposure: "private",
        description: "Private events",
      },
      { path: "public-events", kind: "http", description: "Public events" },
    ],
  }).routes;
  const pending = [{ plugin: "example-plugin", digest: "pending", routes }];
  const resolution: PluginIngressResolution = {
    approved: [],
    pending,
    problems: [{ plugin: "invalid-plugin", reason: "Invalid declaration" }],
  };
  const handlers = createPluginIngressRoutes(() => resolution);
  const lookup = handlers[0]!;

  it("exposes only a read-only lookup and validates its parameters", () => {
    expect(handlers.map((handler) => handler.method)).toEqual([
      "lookup_plugin_ingress_route",
    ]);
    expect(
      lookup.schema?.safeParse({
        plugin: "example-plugin",
        path: "private-events",
      }).success,
    ).toBe(true);
    expect(
      lookup.schema?.safeParse({ plugin: "../other", path: "events" }).success,
    ).toBe(false);
  });

  it("resolves pending declarations without changing approval state", () => {
    expect(
      lookup.handler({ plugin: "example-plugin", path: "private-events" }),
    ).toEqual({
      status: "declared",
      path: "private-events",
      kind: "http",
      exposure: "private",
    });
    expect(
      lookup.handler({ plugin: "example-plugin", path: "public-events" }),
    ).toEqual({
      status: "declared",
      path: "public-events",
      kind: "http",
      exposure: "public",
    });
    expect(resolution.approved).toEqual([]);
    expect(resolution.pending).toEqual(pending);
  });

  it("distinguishes undeclared routes from invalid declarations", () => {
    expect(
      lookup.handler({ plugin: "example-plugin", path: "missing" }),
    ).toEqual({ status: "undeclared" });
    expect(
      lookup.handler({ plugin: "missing-plugin", path: "events" }),
    ).toEqual({ status: "undeclared" });
    expect(
      lookup.handler({ plugin: "invalid-plugin", path: "events" }),
    ).toEqual({ status: "invalid", reason: "Invalid declaration" });
  });
});
