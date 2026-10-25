import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const source = (relative: string) =>
  readFileSync(path.join(root, relative), "utf8");
const require = createRequire(import.meta.url);

describe("private source packaging", () => {
  test("private CLI target comes from a build definition, not a personal path", () => {
    const text = source("src/main/private-candidate.ts");
    expect(text).not.toMatch(/\/Users\/[^/]+\//);
    expect(text).toContain("__VELLUM_PRIVATE_CLI_ENTRY__");
  });
  test("build stamp uses Git rather than a historical label", () => {
    expect(source("electron.vite.config.ts")).not.toContain(
      'return "juno-claude-oct25"',
    );
  });
  test("pack cannot publish, launch, or seed a public CLI", () => {
    const text = source("scripts/pack.sh");
    expect(text).toContain("--publish never");
    expect(text).not.toContain("--publish always");
    expect(text).not.toMatch(/^\s*open\s/m);
    expect(text).not.toContain("generate-cli-lockfile.sh");
  });
  test("builder has no update feed or CLI seed and uses explicit ad-hoc signing", () => {
    const config = require("../electron-builder.config.cjs");
    expect(config.publish).toBeNull();
    expect(config.mac.identity).toBe("-");
    expect(config.mac.notarize).toBe(false);
    expect(
      config.extraResources.some(
        (r: { to: string }) => r.to === "cli-lockfile",
      ),
    ).toBe(false);
    expect(config.directories.output).toBe("dist-private");
  });
});

describe("private build inputs", () => {
  test("missing, relative and nonexistent private targets fail closed", async () => {
    const { resolvePrivateCliEntry } = await import("./private-build-config");
    for (const value of [
      undefined,
      "",
      "relative/cli.ts",
      "/private-fixture/missing.ts",
    ]) {
      expect(() => resolvePrivateCliEntry(value)).toThrow(
        "VELLUM_PRIVATE_CLI_ENTRY",
      );
    }
    expect(resolvePrivateCliEntry(import.meta.path)).toBe(import.meta.path);
  });
  test("pack rejects launch flags before building", async () => {
    const child = Bun.spawn(
      ["bash", path.join(root, "scripts/pack.sh"), "--open"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "launch/publication are disabled",
    );
  });
});
