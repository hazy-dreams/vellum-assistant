# Claude subscription profiles

Claude subscription is a separate provider from Anthropic in the existing
Language Model settings. Anthropic uses an API key and API credits. Claude
subscription uses the Claude Agent SDK and the existing Claude Code sign-in
on the computer running your assistant.

## Setup

1. Install the official, unmodified Claude Code on the assistant's computer.
2. Sign in to Claude Code there using your Claude subscription. If your browser
   or phone is connected to an assistant on another computer, signing in on your
   browser's computer does not configure the assistant's computer.
3. In Settings, open AI, then Language Model, then add a provider. Choose
   **Claude subscription**. Vellum does not request an API key, OAuth token, or
   launch a Claude login flow.
4. Leave the executable path blank for automatic discovery. If Claude Code is
   installed outside the normal locations, enter its absolute executable path.
   This path applies to every Claude subscription profile for the assistant.
5. Add a profile using **Claude subscription** and select **Claude Opus
   (subscription)**, **Claude Sonnet (subscription)**, or **Claude Haiku
   (subscription)**. The aliases follow the models available through Claude Code
   and your account.
6. Pick that profile in the chat's model selector. The subscription wording stays
   visible even when you give the profile a custom name. Use **Set as default**
   on the provider to route requests without a profile override through the
   subscription. Selecting a chat profile controls that conversation. Existing
   chat-profile and background-task overrides keep their selected providers;
   review them under the Language Model settings' Overrides section if you
   want those requests to use the subscription too.

Saving settings does not generate a test response. Opus and Sonnet profiles
expose effort settings; API sampling controls and fixed token ceilings are not
shown for these subscription aliases.

Claude Agent SDK does not provide embeddings. Memory embeddings keep their
separately configured backend (`memory.embeddings`) and may incur API or
managed-service charges, even when Claude subscription is the default LLM
provider.

## Errors and limits

- An older assistant must be updated before the provider can be added. Failed
  compatibility or configuration reads have a retry action in the form
- A relative executable path is rejected. Clearing the field restores automatic
  discovery
- Missing Claude Code or a missing subscription sign-in produces an explicit
  setup error when a request is made. Install or sign in using Claude Code on
  the assistant's computer, then retry
- Subscription limits and model availability apply. Requests use ordinary
  retries. Subscription connections do not receive a managed automatic backup
- Existing overrides and missing-connection fallback to the provider's default
  transport still apply. Check your profile and fallback settings; separate
  services and API overrides may incur charges
- This provider is available to self-hosted assistants. A platform-hosted
  assistant cannot use a Claude Code installation on your computer
- Other providers and saved API-key connections keep their existing behavior

Voice transcription and synthesis also keep their separately configured
services and billing; the Claude SDK provider covers language-model inference.
