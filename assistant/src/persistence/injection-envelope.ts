/**
 * The per-turn injected blocks that wrap a user message outside its memory
 * region: everything runtime assembly prepends above the memory prefix and
 * appends after the original content. Persisted under
 * `metadata.injectionEnvelope` so `loadFromDb` rebuilds the message
 * byte-for-byte after a daemon restart or conversation eviction, keeping the
 * provider prefix cache anchored.
 *
 * A block that already persists under its own metadata key is recorded as a
 * `ref` to that key rather than repeating its text.
 *
 * Leaf module (zod only) so the storage schema and the daemon share it
 * without pulling in the conversation-crud graph.
 */
import { z } from "zod";

/** Metadata keys an envelope entry may reference instead of repeating its text. */
export const INJECTION_ENVELOPE_REF_KEYS = [
  "workspaceBlock",
  "backgroundTurnBlock",
  "turnContextBlock",
  "channelCapabilitiesBlock",
  "nonInteractiveContextBlock",
] as const;

export type InjectionEnvelopeRefKey =
  (typeof INJECTION_ENVELOPE_REF_KEYS)[number];

const injectionEnvelopeEntrySchema = z.union([
  z.object({ text: z.string() }),
  z.object({ ref: z.enum(INJECTION_ENVELOPE_REF_KEYS) }),
]);

export const injectionEnvelopeSchema = z.object({
  prefix: z.array(injectionEnvelopeEntrySchema),
  suffix: z.array(injectionEnvelopeEntrySchema),
});

export type InjectionEnvelopeEntry = z.infer<
  typeof injectionEnvelopeEntrySchema
>;
export type InjectionEnvelope = z.infer<typeof injectionEnvelopeSchema>;

/**
 * The envelope persisted on a message's metadata, resolved to the text blocks
 * it stands for (`ref` entries read from the same metadata record). `null`
 * when the row carries no valid envelope, so the caller falls back to the
 * per-key layout. A `ref` whose key holds no string resolves to nothing.
 */
export function readInjectionEnvelope(
  meta: Record<string, unknown>,
): { prefix: string[]; suffix: string[] } | null {
  const parsed = injectionEnvelopeSchema.safeParse(meta.injectionEnvelope);
  if (!parsed.success) {
    return null;
  }
  const resolve = (entries: InjectionEnvelopeEntry[]): string[] =>
    entries.flatMap((entry) => {
      if ("text" in entry) {
        return [entry.text];
      }
      const value = meta[entry.ref];
      return typeof value === "string" ? [value] : [];
    });
  return {
    prefix: resolve(parsed.data.prefix),
    suffix: resolve(parsed.data.suffix),
  };
}
