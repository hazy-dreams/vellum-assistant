import { describe, expect, test } from "bun:test";

import { computeToolApprovalDigest } from "../../security/tool-approval-digest.js";
import { shellTool } from "../terminal/shell.js";
import {
  MAX_ENCODED_CREDENTIAL_LIST_CHARS,
  prepareBuiltinShellInput,
} from "../terminal/shell-input.js";
import { parseToolInput } from "../tool-input-schemas.js";

const base = {
  command: "echo fixture",
  network_mode: "proxied",
  activity: "Test input",
};
const refs = ["fixture/token", "fixture/second"];

describe("bash credential input compatibility", () => {
  for (const [label, value] of [
    ["actual array", refs],
    ["JSON-encoded array", JSON.stringify(refs)],
    ["JSON whitespace", ` \n ${JSON.stringify(refs)} \t `],
    ["empty array", []],
    ["encoded empty array", "[]"],
  ] as const) {
    test(`accepts ${label} without changing credential identity`, () => {
      const input = {
        ...base,
        credential_ids: value,
        extra: { untouched: true },
      };
      const before = structuredClone(input);
      const result = parseToolInput("bash", input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.message);
      }
      const expected = typeof value === "string" ? JSON.parse(value) : value;
      expect(result.data).toEqual({ ...input, credential_ids: expected });
      expect(parseToolInput("bash", result.data)).toEqual(result);
      expect(input).toEqual(before);
    });
  }

  const invalid: unknown[] = [
    '["fixture/token",',
    "fixture/token",
    JSON.stringify("fixture/token"),
    JSON.stringify(JSON.stringify(refs)),
    null,
    "null",
    {},
    "{}",
    ["fixture/token", 7],
    '["fixture/token",7]',
    [true],
    [null],
    [["fixture/token"]],
    [""],
    '[""]',
    7,
    false,
  ];
  for (const [index, value] of invalid.entries()) {
    test(`rejects malformed shape ${index} instead of dropping credentials`, () => {
      const result = parseToolInput("bash", { ...base, credential_ids: value });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("malformed credentials unexpectedly accepted");
      }
      expect(result.message).toContain("credential_ids");
    });
  }

  test("omission remains valid and never discovers credentials", () => {
    expect(parseToolInput("bash", base)).toEqual({ ok: true, data: base });
  });

  test("does not add compatibility coercion for other fields", () => {
    const result = parseToolInput("bash", {
      ...base,
      credential_ids: JSON.stringify(refs),
      timeout_seconds: "330",
      background: "true",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.data.credential_ids).toEqual(refs);
    expect(result.data.timeout_seconds).toBeUndefined();
    expect(result.data.background).toBeUndefined();
  });

  test("advertises the canonical array contract, not an untyped value", () => {
    const schema = shellTool.input_schema as {
      properties: Record<string, { type?: string; items?: { type?: string } }>;
    };
    expect(schema.properties.credential_ids.type).toBe("array");
    expect(schema.properties.credential_ids.items?.type).toBe("string");
  });
});

describe("canonical shell input preparation", () => {
  const owner = { kind: "default" as const };
  test("bounded single decode accepts exact limit and rejects excess without partial parsing", () => {
    for (const length of [
      MAX_ENCODED_CREDENTIAL_LIST_CHARS,
      MAX_ENCODED_CREDENTIAL_LIST_CHARS + 1,
    ]) {
      const value = "[]" + " ".repeat(length - 2);
      expect(
        prepareBuiltinShellInput(
          "bash",
          { ...base, credential_ids: value },
          owner,
        ).ok,
      ).toBe(length === MAX_ENCODED_CREDENTIAL_LIST_CHARS);
    }
  });
  test("does not trim, deduplicate or rewrite supplied reference identity", () => {
    const credential_ids = [
      " fixture/token ",
      "fixture/token",
      "fixture/token",
    ];
    const input = Object.freeze({
      ...base,
      credential_ids: Object.freeze(credential_ids),
    });
    const prepared = prepareBuiltinShellInput("bash", input, owner);
    expect(prepared).toEqual({ ok: true, data: input });
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    expect(prepared.data).not.toBe(input);
    expect(prepared.data.credential_ids).not.toBe(credential_ids);
    expect(prepareBuiltinShellInput("bash", prepared.data, owner)).toEqual(
      prepared,
    );
  });
  test("both representations yield one approval identity without weakening the digest", () => {
    const normal = { ...base, credential_ids: refs };
    const raw = { ...base, credential_ids: JSON.stringify(refs) };
    const prepared = prepareBuiltinShellInput("bash", raw, owner);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    expect(computeToolApprovalDigest("bash", prepared.data)).toBe(
      computeToolApprovalDigest("bash", normal),
    );
    expect(computeToolApprovalDigest("bash", raw)).not.toBe(
      computeToolApprovalDigest("bash", normal),
    );
  });
  for (const kind of [
    "workspace",
    "plugin",
    "mcp",
    "skill",
    undefined,
  ] as const) {
    test(`does not normalize ${kind ?? "missing"} ownership`, () => {
      const raw = { ...base, credential_ids: JSON.stringify(refs) };
      expect(
        prepareBuiltinShellInput("bash", raw, kind ? { kind } : undefined),
      ).toEqual({ ok: true, data: raw });
    });
  }
  test("does not normalize other tools", () => {
    const raw = { credential_ids: JSON.stringify(refs) };
    expect(prepareBuiltinShellInput("host_bash", raw, owner)).toEqual({
      ok: true,
      data: raw,
    });
  });
});
