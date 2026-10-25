# Native history and workflow continuity

This source change reduces unnecessary Claude native-session rebuilds and prevents foreground work from overlapping a background wake. A source commit is not a deployment; activation and restart remain separately authorized operations.

## Stable, conservative history identity

Native reuse must distinguish model-relevant history from display-only state. UI cards can be added or updated after a successful turn, and history repair can regroup adjacent same-role messages without changing the ordered content blocks. Neither should force a new native session on its own.

The session comparison uses an ordered, role-labelled content frontier rather than raw message boundaries. Display-only UI data is excluded, while meaningful text, tools, results, attachments and opaque reasoning identity remain guarded. The frontier must split a newly regrouped message at the old/new boundary so historical text or tool actions cannot become a fresh request. Reuse still requires clean settlement, a matching configuration fingerprint, an unchanged semantic prefix and a genuinely new user request.

Older state is handled conservatively. Valid version 1 mappings retain their exact whole-message hash checks and require a genuinely appended user request; the first verified transition creates a fresh version 2 native session rather than reinterpreting hashes. Unchanged clean or interrupted history is rejected without rewriting state. If the legacy prefix cannot be verified, migration fails explicitly and requires restoring the unchanged history or starting a new conversation. It does not guess which old request to replay. This is an intentional one-time compatibility boundary, covered by authentic version 1 fixtures and stale-completion tests.

For required rebuilds, the runtime applies outbound sanitization after the store's history split. This keeps the verified current-request boundary aligned even when repair merged old and new blocks into one message. Durable canonical history is not replaced by the sanitized transport projection.

## Wake ownership

Every wake needs an owned cancellation controller and processing claim, not just scheduled runs. A user steering a workflow wake must abort that wake and wait for it to unwind, rather than interpreting its missing controller as stale state and starting a second loop.

Cleanup releases only the claim and controller it owns. It restores turn-scoped state before announcing idle, finishes persistence before draining queued work, and covers preparation failures and cancellation during compaction. Cron-specific run identity and existing trust, interactivity, question and tool policies remain separate from this generic ownership mechanism.

## Durable workflow completion events

Workflow completion uses the existing persisted background-event path. The framing is fixed text, and the summary, including user-provided labels and agent output, is fenced as untrusted tool-result data. This retains the event in future history instead of sending an ephemeral prompt that disappears before the next turn. Workflow wakes explicitly remain noninteractive; their captured trust still governs execution.

## Validation boundaries

Offline regressions exercise the session store, fake SDK transport with real adapter/tool bridges, real steering-handler behavior, pending-question cancellation, queued-wake ordering, compaction cancellation, and workflow completion options. Genuine text/tool-result edits, interrupted work, mismatched fingerprints and stale completions must continue to fail closed. Historical tool actions must never replay during a resume or rebuild.

This change passed 915 focused offline tests with 3,389 assertions across 42 individually isolated test files (one existing TODO), full backend `tsc --noEmit`, and changed-file ESLint, Prettier and whitespace checks. The original cosmetic-history, non-cron steering, ephemeral-trigger, legacy migration and rebuilt-frontier failures were reproduced before their fixes. Re-run the relevant files from `assistant/`, not an unscoped monorepo test run:

```sh
bun test src/agent/claude-sdk/session.test.ts
bun test src/agent/claude-sdk/runtime-regressions.test.ts
bun test src/runtime/__tests__/agent-wake.test.ts
bun test src/workflows/run-manager.test.ts
bunx tsc --noEmit
```

Passing these checks is not proof of provider-side cache hits, subscription allowance savings, real browser/OS approval delivery, or native post-cancel behavior. The inherited abort-during-session-completion write race and native post-cancel retry investigation remain separate. No live Claude inference, registry change, runtime overlay or restart is part of publishing this source.
