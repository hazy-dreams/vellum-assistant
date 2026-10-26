# Claude subscription runtime

`claude-agent-sdk` is a separate provider/profile choice from the Anthropic API
provider. It uses `@anthropic-ai/claude-agent-sdk` 0.3.296 with an existing,
unmodified Claude Code installation on the assistant host. There is no token
import, OAuth proxy, API-key conversion, or Vellum-hosted login flow.

## Boundaries

- `agent/loop.ts` resolves the ordinary call-site/profile configuration before
  dispatching an SDK agent turn. Conversation turns, scheduled wakes, subagents
  using Conversation, and workflow tool leaves share this dispatch boundary.
- `agent/claude-sdk/runtime.ts` owns one SDK query lifecycle. Claude owns its
  model/tool iteration and internal compaction. Vellum owns its existing
  executor, permissions, plugin tool hooks, canonical history and client events.
- `tools.ts` exposes only the supplied Vellum tools through an in-process MCP
  server. Built-in tools, external MCP configuration, local skills and plugins
  are disabled. Organization-managed Claude Code policy hooks can still run
  outside the Vellum executor; Vellum does not override organization policy.
  A provenance check and an invocation-ID/input match precede
  execution. Duplicate IDs share one execution; exclusive-tool siblings are
  deferred. The pinned SDK server's `disableAutoBackground` flag keeps real
  tool completion ahead of the next inference round.
- The pre-model hook runs at the Vellum dispatch boundary. Post-model and
  post-tool hooks run for streamed SDK messages and Vellum tool results.
  Hook-added tools use the same executor. Model-only hook guidance stays out of
  client tool output. Append-only continuation nudges are supported; rewriting
  earlier history during an active SDK query fails explicitly, rather than
  silently losing the rewrite or replaying actions.
- SDK internal rounds do not re-run the Vellum pre-model context preparation or
  its mid-loop compactor. Confirmed profile changes take effect on a subsequent
  Vellum dispatch. These are explicit integration boundaries, not claims of
  interchangeable internal loop behavior.
- `providers/claude-agent-sdk/client.ts` handles auxiliary inference through
  bounded, tool-free SDK queries, including structured output. Once selected,
  the adapter uses the SDK for titles, classification and memory selection.
  Provider resolution, explicit overrides and soft connection failures retain
  the existing shared routing behavior.

## Authentication and billing

`auth.ts` resolves the installed executable and runs read-only version and
`auth status` probes with the same working directory and restricted environment
used for inference. API/cloud/federation/token overrides are rejected. No
credential file or keychain contents are read by Vellum. Diagnostics do not
return raw auth output or account identifiers.

The supported baseline is Claude Code 2.1.296, paired in the pinned SDK release.
Vellum rejects older, prerelease, or unrecognized versions. Newer stable versions
pass the minimum check; this does not mean every later release was tested, or
that Anthropic universally requires this minimum for all SDK uses.

Subscription limits and account-level extra-usage settings still apply. This is
not a spending cap or a promise of zero incremental charges. Auxiliary requests
use the shared retry wrapper, like ChatGPT subscription requests. Existing
adapter construction supplies automatic backup-profile failover only to
Vellum-managed connections, not subscription/no-auth connections. The SDK owns
recovery within a root agent query; Vellum does not replay that query after a
possibly completed tool effect.

The separate, pre-existing connection-resolution behavior is unchanged: a soft
failure to construct a requested provider adapter can use the default transport,
which may be API-billed. Explicit profile and call-site overrides also retain
their existing behavior and charges. This integration does not add a global
no-fallback policy or subscription backup feature. Saving a profile skips the
model-generation validation probe.

The SDK does not provide embeddings. Memory embedding generation keeps its
separately configured `memory.embeddings` backend, which may use local models
or incur API/managed charges. Changing the LLM profile does not change that
service or make the whole assistant subscription-only. Voice transcription and
synthesis likewise retain their separately configured services and billing.

## Provider settings and accounting

Root dispatch validates the selected connection through the same configured-
provider boundary as other inference. An unavailable SDK connection is reported
before the SDK starts; it is not silently run through the auxiliary adapter.
Shared provider fallback rules are unchanged.

Root and auxiliary requests share effort/thinking normalization. Claude's effort
levels are `low`, `medium`, `high`, `xhigh`, and `max`; the profile picker offers
only levels reported by discovery. Legacy `none` or disabled-thinking settings
without an explicit effort become `low`, a latency preference rather than a
promise that thinking is disabled. Explicit effort wins over a legacy thinking
toggle. Generic thinking hints leave model-specific defaults to Claude Code;
explicit fixed thinking budgets remain explicit. Claude Code applies its native
model-specific effort support rules. See [effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).

The configured provider timeout is passed as milliseconds in the SDK query's
private environment: `API_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, and
`CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`. Claude Code owns request deadlines, stream
watchdogs, retries and teardown; Vellum does not put a whole-agent timer around
MCP tools or approval waits. Native idle watchdogs are not a fixed total-response
deadline: Claude Code clamps event-idle values to at least five minutes and
byte-idle values to ten seconds through thirty minutes. Native request timers
are capped at the timer-safe maximum. Auxiliary inference also retains its
existing bounded, tool-free query timeout. See [native stream watchdogs](https://code.claude.com/docs/en/network-config#streaming-idle-watchdogs).

Assistant-only frames preserve each content block while deduplicating input and
cache usage by API message ID. Their output counts are placeholders, so final
per-turn result usage supplies output totals after already-accounted streaming
output is removed. Aggregates preserve call counts and the latest context size;
mixed-model aggregates use an unknown model rather than inventing per-model
output attribution. A failed query without a result retains known input/cache
usage with unknown output counted as zero. Session-cumulative cost/model totals
are not added to per-turn usage. See [SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

Successful spooling passes the saved, shortened result through post-tool hooks
and conversation history. If saving an oversized tool result fails, the SDK bridge logs the failure and
continues with the completed in-memory result, matching the native loop. It does
not rerun the tool to recover a spool file.

## Context estimation and automatic compaction

Each root streamed model call pairs its raw local prompt estimate with Claude's
reported input, including cache reads and cache creation. The estimate covers
full canonical history, the caller's system-prompt scope and current Vellum tool
definitions before that call adds output. Resumed sessions are estimated from
full history, not just the appended prompt. Native-only overhead is learned
through the existing actual-to-estimated correction ratio, rather than a fixed
extra-token allowance.

Foreground turns and background wakes use the same calibration recorder and
canonical provider key as the existing budget estimators. Assistant-only fallback
usage remains uncalibrated because it can aggregate multiple calls without a
reliable input boundary. Aggregate events never train one prompt's estimate;
usage totals and call counts retain their existing accounting.

Calibrated estimates feed Vellum's existing turn-start compaction checks. They do
not add checks or stop/restart machinery inside a running SDK query. The shared
calibrator retains its minimum-sample and outlier guards, smoothing and
process-local lifetime: restarting clears learned corrections. This is not an
exact tokenizer or a guarantee that every native call stays below the configured
Vellum budget.

## History, resume and interruption

Vellum persists only a session mapping, message hashes and an in-flight marker
in `.claude-sdk-session.json` within its conversation directory. Native Claude
transcripts remain managed by Claude Code. Resume requires an exact canonical
history prefix and matching runtime fingerprint. Dirty, aborted, changed or
forked sessions rebuild from labelled history on a new user request; the same
interrupted prompt is never automatically replayed.

Historical tools/results are inert context when bootstrapping a session. Current
images and PDFs use the SDK's native content blocks. Vellum memory injections
remain part of its prepared conversation context; Claude Code automatic memory
is disabled. Cancellation closes the query, bounds tool settlement and records
an unknown outcome for abandoned calls so clients do not assume they failed
without effects. Late results cannot mutate the next turn.

## License and distribution

The SDK is not MIT-licensed. Its package notice is:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
> outlined here: https://code.claude.com/docs/en/legal-and-compliance.

The package and bundled Claude Code artifacts retain their upstream notices.
Installing this dependency does not change Vellum's repository license, grant
Anthropic partnership/approval, or establish redistribution rights beyond those
terms. This integration selects a separately installed, unmodified Claude Code
binary; it does not patch that binary. Review the linked terms before shipping
or redistributing an application containing the dependency.

## Verification

Tests use injected SDK transports, synthetic events and an in-memory MCP client.
They do not sign in, read credentials, or make paid/subscription model calls.
Auth, inference, session integrity, permissions, event ordering, cancellation,
profile routing and UI settings have focused tests. Real Claude login, live
model/tool streaming, OS packaging and end-to-end scheduled wake/resume remain
manual validation requirements before release. The draft is not a live parity
certification.

Official references: [SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript),
[custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools),
[sessions](https://code.claude.com/docs/en/agent-sdk/sessions), and
[SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

## Model discovery

The Claude subscription profile picker asks the installed SDK for its supported
models. This reuses the delegated-agent convention: runtime-provided IDs and
labels are authoritative, and a saved model ID remains visible even when it is
absent from the latest list. Aliases and versioned IDs pass through unchanged.
The default profile intents still use `sonnet`, `opus`, and `haiku` aliases.

`POST /v1/inference/models/discover` requires `settings.write`, initializes a
no-prompt SDK session and reads
`supportedModels()`. It does not submit a generation request. Initialization can
still perform Claude Code startup, authentication, and network activity. Results
are briefly cached; Refresh bypasses cached metadata, while concurrent requests
share the complete operation, including authentication preflight. Cached metadata
still requires a successful authentication check. A failed refresh is
shown explicitly and does not silently substitute the static catalog. The
ordinary `GET /v1/inference/models` endpoint remains the offline catalog for
existing clients and providers.

Effort choices come from the SDK metadata. Its current model interface does not
report context-window, output-token, vision, or tool-use limits; discovery does
not invent those values. A discovered choice is not a promise of current quota
or successful access: Claude remains responsible for validating a model when it
is used. Saved SDK model IDs are not rejected against Vellum's static catalog,
including after restarting the assistant. New choices can appear on refresh
without a Vellum catalog release, subject to what the installed Claude Code and
SDK version report.

## Background continuation and tool definitions

Helper notifications retain the parent conversation and run as non-interactive
turns. Model-visible definitions stay stable across presence changes where
otherwise supported. Guardian background turns retain foreground tool access:
questions and policy-required approvals may await a real human response, and
host tools and host attachments use their normal approval and client-routing
paths instead of being rejected solely because a turn started in the background.
The turn's captured trust remains authoritative; a presence pin or tool input
cannot grant owner authority. Non-owner, role, read-only, platform, plugin,
exclusion, explicit-deny, same-user host routing and cleanup restrictions remain.
Foreground and background approval thresholds remain independently configurable;
matching presets gives matching risk-policy behavior. Full Access is not an OS
grant or a substitute for a question's actual response.

System-permission requests now use a real question lifecycle even when tool risk
policy auto-approves the invocation. They report the user's response and require
verification by retrying the original operation, never claiming an OS grant.
Unsupported channels and legacy native interfaces receive truthful fallback
instead of an unanswerable card. Requests share the question timeout budget;
abort and timeout clean up pending state. Reconnect during a live prompt is
supported; suspension across a daemon restart is not promised.

Offline regressions cover foreground/helper/foreground byte-identical tool
schemas, one native session with appended-only requests, no historical action
replay, unchanged prior-message prefixes, owner direct/skill-dispatch parity,
non-owner restrictions, and real pending-question/approval lifecycle with
simulated human responses. Real model, system, tool or canonical-history changes
still invalidate reuse. Existing dirty/abort/settlement checks are unchanged.
Same-session reuse preserves cache opportunities, not guaranteed server hits or
quota savings. These tests do not certify real client delivery or OS grants.

## Session completion in the Juno branch

Parallel tool results share one canonical user message. Native advisory hook
context does not automatically invalidate a session: completion requires a
successful terminal result, delivered guidance followed by a model frame,
settled MCP delivery/observers, no unfinished calls or hooks, and unchanged
canonical-history compatibility. Native guidance persists in Claude's session,
not Vellum's visible history; rebuilding from canonical history drops it.

An explicit native tool yield stops cooperatively at `PostToolBatch` after the
whole tool batch is delivered. Reuse requires `success`, `is_error:false`,
`terminal_reason:"hook_stopped"`, an uncancelled returned stop hook and no later
model continuation. Checkpoint handoffs and synthetic yields keep their
conservative interruption boundary. Existing dirty mappings are not cleared.

Offline transport tests and pinned native contract inspection are not live quota
measurements. Native session reuse and server prompt-cache reuse are different;
cached context still consumes allowance. An inherited cancellation race during
the asynchronous session-completion write and a native post-cancel retry edge
remain unresolved. No universal cancellation-safety claim is made.
