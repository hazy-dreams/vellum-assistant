# iMessage home channel

Status: design, branch `feat/imessage-home-channel` (from fork `main` 3266bf3a82). Not installed or activated.

## Why this exists

Ramon wants iMessage to be where he and Juno talk day to day. It should behave like texting a person:

- **One home conversation that never resets.** It runs in a single always-on Vellum conversation, kept alive by compaction, and stays separate from desktop and web chats.
- **Each paragraph arrives as its own text**, the way a person texts.
- **Background work reports to Juno first.** Schedules, subagents and background commands wake her inside the home conversation. She decides what, if anything, to text. Jobs never notify Ramon directly.
- **Only Ramon gets in**, and nothing on the Mac has to be reachable from the public internet.

This is a first-class built-in channel (`imessage`), the same kind of channel as `telegram` and `whatsapp`. It is not a workspace plugin. Vellum's plugin-channel path still exists, and the old `vellum-ai/imessage` plugin used it. We use that plugin only as a source of facts about the vendors.

## Shape

```
Linq (v3 partner API)          other line providers later (local Messages via imsg, Photon, ...)
      |  poll (v1) | webhook (later)
gateway/src/imessage/   provider adapter -> normalize -> admit -> handleInbound
      |                                   (dedupe on provider event id, iMessage-only trust)
assistant runtime       home conversation (persistent binding per chat)
      |
assistant/src/messaging/providers/imessage/   ChannelTransport: deliver / react / setActivity / edit / addressFor
```

The provider is chosen behind a small interface on both sides, so swapping the line provider (or adding a local-Messages line later) changes only the adapter.

### Gateway: ingress

- `gateway/src/imessage/provider.ts` defines a `LineProvider` interface: `listNewInbound(cursor)`, `verifyWebhook(req)`, and identity normalization. `linq/` is the first implementation.
- **Poll first.** A gateway-owned poller lives next to Discord's long-lived socket. Like the Discord socket, it starts when credentials appear and stops when they go away. Our ingress URL is tailnet-only and we deliberately have no Funnel, so polling needs zero public exposure. The cursor is stored in the gateway DB, so a restart never replays history and never skips messages.
- **Webhook later.** The route is `/webhooks/imessage`. Requests are verified with Standard Webhooks: the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, a `whsec_` secret, a 5-minute replay window, and a constant-time comparison. The subscription URL pins `?version=2026-02-03`. The route stays off until a webhook secret exists, and it only matters if Ramon chooses to expose a single path.
- Normalization follows `gateway/AGENTS.md` identity vocabulary:
  - `externalMessageId` is the provider's per-event id. Linq can deliver the same event more than once, so this id is what makes repeats harmless.
  - `conversationExternalId` is the provider chat id.
  - `actorExternalId` is the sender handle in E.164 form or as an email address.
- **Admission is iMessage-only for trust.** Linq falls back to SMS and RCS, and SMS sender ids can be spoofed. Anything not explicitly delivered as iMessage is classified as `sms` and can never match the guardian's iMessage identity. Unknown senders are dropped and logged, and nothing reaches the model.
- Fast bursts of texts are left to the runtime's existing per-conversation queue. The gateway does not invent its own batching.

### Assistant: home conversation

- An inbound chat binds to one conversation and keeps it. There is no idle reset. `/new` is the only explicit way to start over, the same as on WhatsApp.
- The home conversation is ordinary Vellum state. Compaction keeps it alive with the existing auto-threshold. Idle-time compaction is a later phase (see `vellum-conversation-compaction` notes), not v1.

### Assistant: outbound transport

`assistant/src/messaging/providers/imessage/transport.ts` implements `ChannelTransport`:

| Capability                          | Linq mapping                                              | Notes                                                                     |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `deliver`                           | `POST /chats/{id}/messages`                               | `idempotency_key` sits inside the message object                          |
| `addressFor`                        | chat id directly                                          | lets Juno text first into the known chat                                  |
| `setActivity` + `activityRefreshMs` | typing indicator                                          | best-effort; Linq only shows it within 5 minutes of chat activity         |
| `react`                             | tapbacks: love, like, dislike, laugh, emphasize, question | anything else is a custom emoji                                           |
| `edit`                              | `PATCH /messages/{id}`                                    | Linq caps edits at 5 within 15 minutes; never falls back to posting again |
| `streamReply`                       | omitted                                                   | iMessage has no streaming primitive                                       |

**Each paragraph goes out as its own text, as a delivery segment.** `channel-reply-delivery.ts` already persists how many segments were delivered and resumes after the last one on retry. The transport therefore declares a `segmentReply(text)` capability, and the delivery loop expands each text segment into paragraph segments _before_ the persisted baseline is applied. If a retry happens after the second of four paragraphs went out, it resumes at the third and nothing is sent twice. Splitting inside `deliver` would lose that guarantee. Code fences and lists stay together as one block, and very long paragraphs are chunked at sentence boundaries. Sends are paced, with a small typing gap between them, to stay well under Linq's limit of 30 messages per minute for one sender and recipient pair.

Each paragraph's idempotency key is derived from the delivery's stable identity plus the segment index. A transport retry then reuses the key, Linq returns the original message instead of sending a duplicate, and the turn that produced the text never runs again.

### Background work into the home conversation (phase 3)

Wakes such as `wakeAgentForOpportunity`, scheduled jobs and background commands already run inside a conversation and persist `<background_event>` triggers. What is missing is delivery. A wake's plain-text reply in a channel-bound conversation is persisted but never sent to the channel. The plan is:

- Wakes targeting the home conversation run with their output delivered through the same `deliverReplyViaCallback` path, using the conversation's outbound binding.
- `<no_response/>` keeps working as deliberate silence, so Juno can read a job result and choose not to text.
- Job producers (schedules, subagents) gain a "report to home" target instead of notifying Ramon directly.

## Credentials and config

- Credential service `imessage` holds `linq_api_token`, and `linq_webhook_secret` if webhooks are ever used. Values are collected only through `assistant credentials prompt` and never appear in config or chat.
- Config section `imessage`: `{ provider: "linq", ingressMode: "poll" | "webhook", pollIntervalMs, timeoutMs }`.
- Ramon's verified iMessage handle on the guardian contact is the only identity admitted by default.

## Linq facts we rely on

- Base URL `https://api.linqapp.com/api/partner/v3`, bearer token. API keys are full read/write; there are no read-only keys.
- A cold send is `POST /messages` with `to` and no `from`, and Linq picks the line. A reply is `POST /chats/{id}/messages`.
- Webhooks are delivered at least once, retried for 30 minutes, with a 10-second response timeout. Redirects can drop the body, so register the final URL.
- The **Hobby** plan is $0, 20 contacts, full API access. It is a shared line that is inbound-first: Ramon texts it before Juno can text him. The **Sandbox** is a separate thing.
- Rate limit is 30 messages per 60 seconds for one sender and recipient pair. The soft guidance is about 7,000 messages per line per day.

## Phases

1. **Channel skeleton.** Covers the `imessage` channel id across contracts, the Linq client, normalization, Standard Webhooks verification and the poller, all tested offline with recorded fixtures.
2. **Two-way home chat.** Covers the transport, paragraph segmentation, typing and tapbacks. Needs Ramon's Linq Hobby account, a token stored through a secure prompt, and an approved install.
3. **Background handoff.** Wake output reaches the channel, and producers report to the home conversation.
4. **Polish.** Guarded idle compaction, optional single-path webhook, attachments, and a local-Messages line provider.

## Boundaries

Merging into `main`, building or installing a desktop/runtime, storing credentials, restarting, and any Tailscale Funnel change each need Ramon's explicit approval. Source work, tests, commits and pushes to this branch do not.
