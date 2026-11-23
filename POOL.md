# t3code-pool

A clean, rebase-friendly fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) adding **multi-account provider pools**, **automatic rate-limit failover**, **sticky thread routing**, and **encrypted Hub ↔ Client synchronization** across desktop, self-hosted server, and mobile.

## What's Added

- **Multi-Account Provider Pools (`providerPools`)**
  - Group multiple accounts of the same provider (e.g. Antigravity, Codex, Claude) into a single logical pool.
  - Strategies: `least_used`, `round_robin`, `priority`.
  - **Sticky threads**: keeps an active thread pinned to its selected account until a rate limit or failure occurs.
  - **Automatic failover (`ProviderPoolFailoverWorker`)**: catches rate-limit / quota exhaustion errors, marks the account on cooldown, and transparently fails over to the next healthy account in the pool.
- **Native T3 Code UI & Mobile Integration**
  - Collapsible pool groups in the Settings → Providers sidebar (`ProviderPoolSidebarGroups`) using native T3 Code components (`Collapsible`, `SettingsGroup`, `SettingsRow`, `CheckboxMark`, `ProviderInstanceIcon`).
  - Pooled providers collapse cleanly into a single pool entry in both the web and mobile model pickers.
  - 10-locale translations (`en`, `ru`, `de`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `sv`, `zh`).
  - Optional background auto-refresh for provider status.
- **Encrypted Hub ↔ Client Synchronization (`providerPoolSync`)**
  - Run one self-hosted T3 Code server in **Hub** mode and connect your laptops/desktops in **Client** mode.
  - Syncs live cooldowns & active leases over `/api/pool-hub/report` and `/api/pool-hub/state` (Bearer token authenticated, constant-time verified).
  - Syncs pools & optional account configurations via AES-256-GCM + PBKDF2 encrypted bundles (`/api/pool-hub/bundle`), persisted across Hub restarts (`pool-hub-bundle.json`).
- **Android Preview APK via GitHub Actions**
  - `.github/workflows/t3code-pool-android-apk.yml` builds side-by-side installable Android `.apk` artifacts (`APP_VARIANT=preview`, `arm64-v8a`) on standard `ubuntu-latest` runners.

## Quick Setup: Hub ↔ Client Sync

1. **On your server (Hub):**
   - Open **Settings → Providers → Provider Pools → Sync**.
   - Enable sync, set mode to **Hub**, and configure a strong **Sync token** and **Vault passphrase**.
2. **On your desktop/laptop (Client):**
   - Enable sync, set mode to **Client**, point **Hub URL** to your server (e.g. `https://your-host`), and enter the same **Sync token** and **Vault passphrase**.
   - If your Hub uses a private/local CA certificate, set `NODE_EXTRA_CA_CERTS=/path/to/ca.crt` before starting T3 Code.
   - Use **Push** from your primary machine and **Pull** on other machines to share pools and encrypted credentials.

## Building Android APK

Run the **Build Android APK (t3code-pool)** workflow manually from the **Actions** tab (choose `preview` to install alongside official T3 Code, or `production`), then download the `.apk` from the workflow run artifacts.

## Keeping Up With Upstream

All pool changes are isolated in dedicated modules (`packages/shared/src/accountPool/*`, `packages/contracts/src/providerPool.ts`, `apps/server/src/provider/ProviderPoolService.ts`, `apps/server/src/provider/PoolHubRoute.ts`, `apps/web/src/components/settings/ProviderPools*.tsx`) with minimal upstream diffs so rebasing onto `upstream/main` stays painless:

```bash
git fetch upstream
git rebase upstream/main
```
