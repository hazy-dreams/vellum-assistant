import { existsSync } from "node:fs";
import path from "node:path";

export function resolvePrivateCliEntry(value: string | undefined): string {
  if (!value || !path.isAbsolute(value) || !existsSync(value)) {
    throw new Error(
      "VELLUM_PRIVATE_CLI_ENTRY must name an existing absolute CLI entry; public fallback is disabled.",
    );
  }
  return value;
}
