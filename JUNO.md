# Juno custom Vellum branch

This is the maintained source branch for a private, Mac-local Vellum installation. `main` stays at the upstream snapshot; custom changes live on `juno`. A source push is not a release, installation or restart.

## Included

- Claude subscription provider and settings UI from the original SDK integration, using native model discovery rather than additional version-pinned aliases.
- GPT-6.1 Sol catalog/routing and 1M context metadata for the existing Claude aliases. Vellum's context budget is separate from native Claude context capacity.
- Canonical parallel-tool result grouping, expected checkpoint interruption handling, conservative native guidance/session reuse, and cooperative explicit-tool yields with terminal acknowledgment.
- Private macOS guards: fixed CLI target and bundled Bun; no public CLI fallback, shared locator/migration/cleanup, wrapper provisioning, automatic relocation, public updater or login-item writes.
- Private build-only packaging with an explicit CLI parameter, Git-derived build stamp, no update feed or public CLI seed, deliberate ad-hoc signing and no automatic launch.

See [Claude runtime documentation](assistant/docs/claude-subscription.md) for integration, accounting and licensing boundaries. The SDK and native executable are not made MIT-licensed by this repository. No third-party binary, extracted native implementation, assistant state, credentials or dependency bundle is checked in.

## Source and installed-build provenance

Upstream base: `146e228b4c8e9111b3c255f0b9c7a82fe2c0cd45`.

The [source baseline manifest](docs/juno-source-baseline.json) records the unchanged integration files reconciled against the installed source. Private desktop sources are normalized separately so personal machine paths are not public. Local deployment receipts must record the source commit, source/artifact hashes, toolchain, target path, signing mode and any deviations; keep those receipts outside this repository.

This consolidation does **not** claim bit-for-bit reproduction of the historical installed desktop. Its assembly predates this source commit and included an incompletely recorded app/asar assembly, a package version override, Electron 42.2.0 and ad-hoc signing. Source package versions also differ by package. Do not infer that a version label identifies a Git commit, that all installed files equal this tree, or that pushing this branch updates an app.

## Source verification

Use a separate checkout, never a running runtime tree. Tool versions are pinned in `.tool-versions`, `.nvmrc`, manifests and `bun.lock`: Bun 1.3.11, Electron 42.2.0, electron-builder 26.8.1 and electron-vite 5.0.0. Put the pinned `bun` and `bunx` on PATH. Record macOS/Xcode versions for native builds.

```sh
bun install --frozen-lockfile --ignore-scripts
bun meta/sync-bundled-copies.ts
bun assistant/scripts/generate-bundled-plugin-packages.ts

(cd assistant && bun run generate:openapi)
(cd clients/web && bun run openapi-ts)
(cd assistant && bun node_modules/typescript/bin/tsc --noEmit -p .)
(cd clients/web && bun node_modules/typescript/bin/tsc --noEmit)
(cd clients/macos && bun node_modules/typescript/bin/tsc --noEmit)

(cd assistant && bun test src/agent/claude-sdk src/agent/loop-claude-sdk.test.ts)
(cd clients/macos && bun test scripts/private-build.test.ts)
(cd clients/macos && bun test src/main/private-guards.test.ts)
(cd clients/macos && bun test scripts/afterSign.test.js)
(cd clients/web && VITE_PLATFORM_MODE=false SENTRY_UPLOAD_SOURCE_MAPS=false bun run build)
```

Run additional changed-file tests separately, from their package directory. Do not run unscoped `bun test` from the repository root: package preloads isolate state, and unrelated files can leak module mocks when combined. Some generated inputs are ignored by Git and must be regenerated on a fresh checkout.

For the desktop JavaScript build and preload check, explicitly select a prepared CLI target:

```sh
export VELLUM_PRIVATE_CLI_ENTRY="$(pwd)/cli/src/index.ts"
export VELLUM_ENVIRONMENT=production
(cd clients/macos && bun run build)
(cd clients/macos && bun test scripts/preload-externals.test.ts)
```

Using a checkout target here is for build verification only. An installed desktop must point to a complete, validated, immutable runtime graph outside a mutable development checkout. The fixed-path existence check alone does not certify that graph or its dependencies.

### Consolidation verification, October 25, 2026

- SDK/dispatch: 255 tests passed, 890 assertions, 9 files.
- Provider/accounting/cache: 73 tests passed in isolated file runs.
- Changed web settings/model-picker tests: 340 passed across 17 files.
- Private desktop guard/build/signing checks: 15 passed; inherited desktop CLI/relocation/menu coverage and preload build check also passed.
- Backend, web and macOS typechecks passed in the isolated checkout. OpenAPI regeneration matched the committed spec. Web production and desktop JavaScript builds passed.
- Initial combined backend run hit cross-file database-mock contamination; the exact SDK suite and other files passed when isolated. The preload test initially lacked `bunx`; it passed with the pinned toolchain on PATH.

These are focused offline checks, not the full monorepo suite or native packaged-app acceptance. The installed-layout typecheck's separate declaration-portability errors are not represented as repaired. No fresh live-Claude inference or subscription quota measurement was performed for consolidation.

## Optional macOS app packaging, build only

Run only in an isolated checkout with locked dependencies and generated inputs prepared. `bun run pack` builds native assets and writes an unpacked app under `clients/macos/dist-private`; it **does not launch, install, publish or restart**. It never generates a public CLI seed. `--open` and other flags are rejected.

```sh
export VELLUM_PRIVATE_CLI_ENTRY=/absolute/immutable-runtime/cli/src/index.ts
export VELLUM_ENVIRONMENT=production
export ELECTRON_TARGET_ARCH=arm64
(cd clients/macos && bun run pack)
```

The path is supplied locally at build time, not committed. The pack script sets explicit ad-hoc signing, disables identity auto-discovery and uses plain entitlements. The builder rejects provisioning profiles. Signing is not notarization and does not guarantee Keychain, safeStorage, Input Monitoring or other native permission continuity.

The full native packaging path was not executed during this source consolidation. Native assets require macOS/Xcode and downloads may be needed; record toolchain/download provenance and inspect all build warnings. Inherited Quick Look hooks can continue without an extension after a build/sign failure, and the Bun fetch helper has incomplete missing-checksum enforcement. Inspect/verify resulting artifacts before any separately approved deployment.

Do not run this command in the existing production graph, replace an installed app, edit registry pointers, or perform an automatic cutover. Deployment requires its own authorization, recovery plan and idle checks. Never move or clean a runtime merely because its historical directory name looks temporary.

## Maintenance discipline

1. Branch from the current `juno` commit in a separate worktree; preserve unrelated dirty work.
2. Add the smallest regression, fix it, and run relevant isolated checks. Avoid live subscription calls for routine adapter tests.
3. Review the complete diff, including new files, for personal paths, secrets, private state and build artifacts. Test logs and deployment receipts stay outside the repository.
4. Commit source and docs; push `juno` only. Verify the remote SHA and unchanged `main`. No automatic release or main merge.
5. When a deployment is separately authorized, record its exact commit and hashes privately. Do not call it installed until process identity/readiness and intended source/artifact hashes are verified.

Known open limits include the inherited abort-during-session-completion write race, native post-cancel retry behavior, unmeasured quota savings, and unverified OS reboot/restore/native-permission continuity. The custom branch is not a blanket certification of these cases.
