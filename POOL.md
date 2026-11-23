# t3code-pool technical notes

Fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) adding multi-account provider pools, automatic rate-limit failover, sticky thread routing, and Hub/Client sync.

## Architecture overview

- **Provider pools (`providerPools`)**
  - Groups multiple accounts of the same provider behind one pool ID.
  - Routing strategies: `least_used`, `round_robin`, `priority`.
  - Sticky threads keep an active thread pinned to its chosen account until a rate limit or error happens.
  - `ProviderPoolFailoverWorker` detects quota and rate-limit failures, puts the account on cooldown, and retries on the next healthy member.
- **UI and mobile**
  - Collapsible pool groups in Settings (`ProviderPoolSidebarGroups`).
  - Pooled accounts collapse into one pool entry in the web and mobile model pickers.
  - Translations for 10 locales (`en`, `ru`, `de`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `sv`, `zh`).
- **Hub and Client sync (`providerPoolSync`)**
  - Live cooldowns and leases sync via `/api/pool-hub/report` and `/api/pool-hub/state` with Bearer token auth.
  - Encrypted vault bundles (AES-256-GCM + PBKDF2) sync via `/api/pool-hub/bundle` and persist on the Hub in `pool-hub-bundle.json`.
  - Cross-OS path sanitization (`mergePulledProviderInstances` in `apps/server/src/provider/ProviderPoolService.ts`) keeps local overrides (`binaryPath`, `homePath`, `shadowHomePath`, `configPath`, `executablePath`) and strips foreign-OS paths on pull.
- **Release builds (`.github/workflows/release.yml`)**
  - Uses upstream `release.yml` to build Windows, macOS, Linux desktop apps, standalone `t3` CLI archives, `SHA256SUMS`, and a signed production Android APK (`APP_VARIANT=production`, `arm64-v8a`).

## Android signing secrets

Repository secrets used by `.github/workflows/release.yml`:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

## Updating from upstream

Pool logic lives in dedicated modules (`packages/shared/src/accountPool/*`, `packages/contracts/src/providerPool.ts`, `apps/server/src/provider/ProviderPoolService.ts`, `apps/server/src/provider/PoolHubRoute.ts`, `apps/web/src/components/settings/ProviderPools*.tsx`) to keep upstream diffs small:

```bash
git fetch upstream
git rebase upstream/main
```
