/**
 * The little the iMessage channel remembers across restarts: how far the
 * poller has read, and which relay subscription a crash might have orphaned.
 *
 * Neither is a secret. The API token stays in the credential store and the
 * webhook signing secret is never written down, so this file can sit in the
 * gateway's private directory with ordinary permissions and be deleted at
 * will; the cost of losing it is one skipped history window and one stale
 * subscription aimed at nothing.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PollWatermarkStore } from "./poller.js";
import type { RelaySubscriptionStore } from "./relay.js";

interface LinqChannelState {
  /** Which line this state belongs to; a different line starts fresh. */
  line?: string;
  watermark?: string;
  relaySubscriptionId?: string;
}

export class LinqStateFile
  implements PollWatermarkStore, RelaySubscriptionStore
{
  private state: LinqChannelState;

  constructor(
    private readonly path: string,
    private readonly line: string,
  ) {
    this.state = this.read();
    if (this.state.line !== line) {
      // Keep the orphaned subscription id: it belongs to this account, not
      // the line, and still needs deleting.
      this.state = {
        line,
        ...(this.state.relaySubscriptionId
          ? { relaySubscriptionId: this.state.relaySubscriptionId }
          : {}),
      };
    }
  }

  static at(dir: string, line: string): LinqStateFile {
    return new LinqStateFile(join(dir, "imessage-linq-state.json"), line);
  }

  loadWatermark(): string | undefined {
    return this.state.watermark;
  }

  saveWatermark(iso: string): void {
    this.state = { ...this.state, watermark: iso };
    this.write();
  }

  loadSubscriptionId(): string | undefined {
    return this.state.relaySubscriptionId;
  }

  saveSubscriptionId(id: string | undefined): void {
    const { relaySubscriptionId: _, ...rest } = this.state;
    this.state = id ? { ...rest, relaySubscriptionId: id } : rest;
    this.write();
  }

  private read(): LinqChannelState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as LinqChannelState)
        : {};
    } catch {
      return {};
    }
  }

  /** Write-then-rename, so a crash mid-write never leaves half a file. */
  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ ...this.state, line: this.line }, null, 2),
    );
    renameSync(tmp, this.path);
  }
}
