import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderInstanceId,
  ProviderPoolId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { resolveAntigravityInstanceDirectories } from "./antigravityAuthSupport.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderPoolService from "./ProviderPoolService.ts";

function makeProvider(instanceId: string, usedPercent: number): ServerProvider {
  return {
    instanceId: instanceId as ProviderInstanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: null,
      },
    ],
    usageLimits: {
      checkedAt: "2026-01-01T00:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "5h",
          usedPercent,
          resetsAt: "2026-01-01T05:00:00.000Z",
          windowDurationMins: 300,
        },
      ],
    },
  };
}

function makeTestLayer(settings: ServerSettings, providers: ReadonlyArray<ServerProvider>) {
  const settingsLayer = Layer.succeed(ServerSettingsModule.ServerSettingsService, {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(settings),
    updateSettings: () => Effect.succeed(settings),
    updateProviderInstance: () => Effect.succeed(settings),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
    withSettingsSnapshot: <A, E, R>(use: (current: ServerSettings) => Effect.Effect<A, E, R>) =>
      use(settings),
  } as unknown as ServerSettingsModule.ServerSettingsService["Service"]);
  const registryLayer = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.succeed(providers),
    refresh: () => Effect.succeed(providers),
    streamChanges: Stream.empty,
  } as unknown as ProviderRegistry.ProviderRegistry["Service"]);
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pool-test-" });
      return { stateDir } as unknown as ServerConfig.ServerConfig["Service"];
    }),
  );

  const randomLayer = Layer.succeed(
    SecureRandom.SecureRandom,
    SecureRandom.make((size) => new Uint8Array(size).fill(7)),
  );

  return ProviderPoolService.layer.pipe(
    Layer.provide(settingsLayer),
    Layer.provide(registryLayer),
    Layer.provide(configLayer),
    Layer.provide(randomLayer),
    Layer.provide(NodeServices.layer),
  );
}

describe("ProviderPoolService", () => {
  it.effect(
    "routes to least-used member, respects sticky thread, and fails over after cooldown",
    () =>
      Effect.gen(function* () {
        const poolId = ProviderPoolId.make("codex-pool");
        const acc1 = "codex-1" as ProviderInstanceId;
        const acc2 = "codex-2" as ProviderInstanceId;
        const settings: ServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerPools: {
            [poolId]: {
              driver: ProviderDriverKind.make("codex"),
              displayName: "Codex Pool",
              enabled: true,
              memberInstanceIds: [acc1, acc2],
              strategy: "least_used",
              autoFailover: true,
              stickyThread: true,
            },
          },
        };
        const providers = [makeProvider("codex-1", 80), makeProvider("codex-2", 15)];

        yield* Effect.gen(function* () {
          const pool = yield* ProviderPoolService.ProviderPoolService;
          const first = yield* pool.resolveModelSelection({
            modelSelection: { instanceId: acc1, model: "gpt-5.4" },
            threadId: "thread-1",
          });
          expect(first.modelSelection.instanceId).toBe(acc2);
          expect(first.switched).toBe(true);
          expect(first.poolId).toBe(poolId);

          // Record usage limit on acc2 -> next resolution should fail over to acc1.
          yield* pool.recordUsageLimit({ instanceId: acc2, reason: "usage_limit" });
          const second = yield* pool.resolveModelSelection({
            modelSelection: { instanceId: acc2, model: "gpt-5.4" },
            threadId: "thread-1",
          });
          expect(second.modelSelection.instanceId).toBe(acc1);
          expect(second.switched).toBe(true);

          // Hub state should expose active cooldown and lease.
          const hubState = yield* pool.getHubState;
          expect(hubState.cooldowns.some((c) => c.instanceId === acc2)).toBe(true);
          expect(hubState.activeLeases[acc1]).toBe(1);

          yield* pool.releaseThread("thread-1");
          const afterRelease = yield* pool.getHubState;
          expect(afterRelease.activeLeases[acc1]).toBeUndefined();
        }).pipe(Effect.provide(makeTestLayer(settings, providers)));
      }),
  );

  it.effect(
    "keeps a thread on its preferredInstanceId after releaseThread even when another account has more quota",
    () =>
      Effect.gen(function* () {
        const poolId = ProviderPoolId.make("agy-pool");
        const acc1 = "agy-1" as ProviderInstanceId;
        const acc2 = "agy-2" as ProviderInstanceId;
        const settings: ServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerPools: {
            [poolId]: {
              driver: ProviderDriverKind.make("codex"),
              displayName: "Agy Pool",
              enabled: true,
              memberInstanceIds: [acc1, acc2],
              strategy: "least_used",
              autoFailover: true,
              stickyThread: true,
            },
          },
        };
        // acc1 has 60% used while acc2 has 10% used — least_used would normally pick acc2.
        const providers = [makeProvider("agy-1", 60), makeProvider("agy-2", 10)];

        yield* Effect.gen(function* () {
          const pool = yield* ProviderPoolService.ProviderPoolService;

          // After previous turn ended and released its active lease, follow-up turn supplies
          // the thread's persisted instanceId (acc1) as preferredInstanceId.
          // Even if the UI sent the pool representative (acc2), stickyThread must keep acc1.
          const followUp = yield* pool.resolveModelSelection({
            modelSelection: { instanceId: acc2, model: "gpt-5.4" },
            threadId: "thread-sticky",
            preferredInstanceId: acc1,
          });
          expect(followUp.modelSelection.instanceId).toBe(acc1);
          expect(followUp.switched).toBe(true);

          // Releasing the lease again and sending another turn still sticks to acc1.
          yield* pool.releaseThread("thread-sticky");
          const followUp2 = yield* pool.resolveModelSelection({
            modelSelection: { instanceId: acc1, model: "gpt-5.4" },
            threadId: "thread-sticky",
            preferredInstanceId: acc1,
          });
          expect(followUp2.modelSelection.instanceId).toBe(acc1);
          expect(followUp2.switched).toBe(false);

          // A brand-new thread (no preferredInstanceId) still uses least_used and gets acc2.
          const newThread = yield* pool.resolveModelSelection({
            modelSelection: { instanceId: acc1, model: "gpt-5.4" },
            threadId: "thread-new",
          });
          expect(newThread.modelSelection.instanceId).toBe(acc2);
          expect(newThread.switched).toBe(true);

          // If acc1 hits a usage limit cooldown, sticky thread fails over to acc2.
          yield* pool.releaseThread("thread-sticky");
          yield* pool.recordUsageLimit({ instanceId: acc1, reason: "usage_limit" });
          const afterLimit = yield* pool.resolveModelSelection({
            modelSelection: { instanceId: acc1, model: "gpt-5.4" },
            threadId: "thread-sticky",
            preferredInstanceId: acc1,
          });
          expect(afterLimit.modelSelection.instanceId).toBe(acc2);
          expect(afterLimit.switched).toBe(true);
        }).pipe(Effect.provide(makeTestLayer(settings, providers)));
      }),
  );

  it.effect("does not stick to preferredInstanceId when pool.stickyThread is false", () =>
    Effect.gen(function* () {
      const poolId = ProviderPoolId.make("codex-pool");
      const acc1 = "codex-1" as ProviderInstanceId;
      const acc2 = "codex-2" as ProviderInstanceId;
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerPools: {
          [poolId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Pool",
            enabled: true,
            memberInstanceIds: [acc1, acc2],
            strategy: "least_used",
            autoFailover: true,
            stickyThread: false,
          },
        },
      };
      const providers = [makeProvider("codex-1", 70), makeProvider("codex-2", 10)];

      yield* Effect.gen(function* () {
        const pool = yield* ProviderPoolService.ProviderPoolService;
        const resolved = yield* pool.resolveModelSelection({
          modelSelection: { instanceId: acc1, model: "gpt-5.4" },
          threadId: "thread-nonsticky",
          preferredInstanceId: acc1,
        });
        expect(resolved.modelSelection.instanceId).toBe(acc2);
        expect(resolved.switched).toBe(true);
      }).pipe(Effect.provide(makeTestLayer(settings, providers)));
    }),
  );

  it("sanitizes foreign-OS paths and preserves local path overrides on pull", () => {
    const winToLinux = ProviderPoolService.mergePulledProviderInstances(
      {
        codex_local: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { binaryPath: "/usr/local/bin/codex", homePath: "/home/ai/.codex" },
        },
      },
      {
        codex_local: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: {
            binaryPath: "C:\\Users\\dev\\codex.exe",
            homePath: "C:\\Users\\dev\\.codex",
            launchArgs: "--full-auto",
          },
        },
        codex_new: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: {
            binaryPath: "C:\\Tools\\codex.exe",
            homePath: "C:\\Users\\dev\\.codex-2",
            shadowHomePath: "\\\\server\\share\\shadow",
            launchArgs: "--quiet",
          },
        },
        codex_bare: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { binaryPath: "codex" },
        },
      },
      "linux",
    );

    // Existing local overrides must win over pulled Windows paths.
    const localCfg = winToLinux["codex_local" as ProviderInstanceId]?.config as
      | Record<string, unknown>
      | undefined;
    expect(localCfg?.binaryPath).toBe("/usr/local/bin/codex");
    expect(localCfg?.homePath).toBe("/home/ai/.codex");
    expect(localCfg?.launchArgs).toBe("--full-auto");

    // Foreign Windows paths on a new Linux instance must be stripped, keeping non-path config.
    const newCfg = winToLinux["codex_new" as ProviderInstanceId]?.config as
      | Record<string, unknown>
      | undefined;
    expect(newCfg?.binaryPath).toBeUndefined();
    expect(newCfg?.homePath).toBeUndefined();
    expect(newCfg?.shadowHomePath).toBeUndefined();
    expect(newCfg?.launchArgs).toBe("--quiet");

    // Portable command names (no path separator) stay intact.
    const bareCfg = winToLinux["codex_bare" as ProviderInstanceId]?.config as
      | Record<string, unknown>
      | undefined;
    expect(bareCfg?.binaryPath).toBe("codex");

    // Pulling POSIX paths onto Windows must strip POSIX absolute/home paths.
    const linuxToWin = ProviderPoolService.mergePulledProviderInstances(
      {},
      {
        claude_1: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: { binaryPath: "/opt/bin/claude", homePath: "~/.claude-alt" },
        },
      },
      "win32",
    );
    const winCfg = linuxToWin["claude_1" as ProviderInstanceId]?.config as
      | Record<string, unknown>
      | undefined;
    expect(winCfg?.binaryPath).toBeUndefined();
    expect(winCfg?.homePath).toBeUndefined();
  });

  it.effect(
    "pushes and pulls Antigravity OAuth profile files through the encrypted hub vault",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const digest = yield* Digest.Digest;
        const sourceStateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pool-src-" });
        const targetStateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pool-dst-" });

        const agyId = "antigravity" as ProviderInstanceId;
        const agyDriver = ProviderDriverKind.make("antigravity");
        const poolId = ProviderPoolId.make("antigravity-pool");

        const sourceDirs = yield* resolveAntigravityInstanceDirectories(sourceStateDir, agyId);
        const sourceAcpDir = path.join(sourceDirs.profile, "antigravity-acp");
        yield* fs.makeDirectory(sourceAcpDir, { recursive: true });
        const oauthTokenContent = '{"access_token":"tok-123","email":"user@example.com"}';
        const installIdContent = "11111111-2222-3333-4444-555555555555";
        yield* fs.writeFileString(
          path.join(sourceAcpDir, "antigravity-oauth-token"),
          oauthTokenContent,
        );
        yield* fs.writeFileString(path.join(sourceAcpDir, "installation_id"), installIdContent);

        const baseSync = {
          enabled: true,
          mode: "hub" as const,
          hubUrl: "",
          syncToken: "test-token",
          syncPassphrase: "strong-vault-passphrase",
          syncCredentials: true,
          pollIntervalSeconds: 15,
        };
        const sourceSettings: ServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [agyId]: { driver: agyDriver, displayName: "Main AGY", enabled: true },
          },
          providerPools: {
            [poolId]: {
              driver: agyDriver,
              displayName: "Antigravity Pool",
              enabled: true,
              memberInstanceIds: [agyId],
              strategy: "least_used",
              autoFailover: true,
              stickyThread: true,
            },
          },
          providerPoolSync: baseSync,
        };

        const makeStatefulLayer = (stateDir: string, initial: ServerSettings) => {
          let current = initial;
          const settingsLayer = Layer.succeed(ServerSettingsModule.ServerSettingsService, {
            start: Effect.void,
            ready: Effect.void,
            getSettings: Effect.sync(() => current),
            updateSettings: (patch: Partial<ServerSettings>) =>
              Effect.sync(() => {
                current = { ...current, ...patch };
                return current;
              }),
            updateProviderInstance: () => Effect.sync(() => current),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.succeed(Stream.empty),
            withSettingsSnapshot: <A, E, R>(
              use: (snapshot: ServerSettings) => Effect.Effect<A, E, R>,
            ) => use(current),
          } as unknown as ServerSettingsModule.ServerSettingsService["Service"]);
          const registryLayer = Layer.succeed(ProviderRegistry.ProviderRegistry, {
            getProviders: Effect.succeed([]),
            refresh: () => Effect.succeed([]),
            streamChanges: Stream.empty,
          } as unknown as ProviderRegistry.ProviderRegistry["Service"]);
          const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
            stateDir,
          } as unknown as ServerConfig.ServerConfig["Service"]);
          const randomLayer = Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(9)),
          );
          return ProviderPoolService.layer.pipe(
            Layer.provide(settingsLayer),
            Layer.provide(registryLayer),
            Layer.provide(configLayer),
            Layer.provide(randomLayer),
            Layer.provide(Layer.succeed(Digest.Digest, digest)),
            Layer.provide(NodeServices.layer),
          );
        };

        // 1. Push on source machine -> produces encrypted bundle with Antigravity profile files.
        const exportedBundle = yield* Effect.gen(function* () {
          const svc = yield* ProviderPoolService.ProviderPoolService;
          const pushed = yield* svc.pushEncryptedBundle;
          expect(pushed.ok).toBe(true);
          expect(pushed.detail).toContain("2 credential(s)");
          return yield* svc.getEncryptedBundle;
        }).pipe(Effect.provide(makeStatefulLayer(sourceStateDir, sourceSettings)));
        expect(exportedBundle).not.toBeNull();

        // 2. Put & pull on target machine -> restores Antigravity OAuth token & installation_id.
        const targetSettings: ServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerPoolSync: { ...baseSync, enabled: false },
        };
        yield* Effect.gen(function* () {
          const svc = yield* ProviderPoolService.ProviderPoolService;
          yield* svc.putEncryptedBundle(exportedBundle!);
          const pulled = yield* svc.pullEncryptedBundle;
          expect(pulled.ok).toBe(true);
          expect(pulled.detail).toContain("2 credential(s)");
        }).pipe(Effect.provide(makeStatefulLayer(targetStateDir, targetSettings)));

        const targetDirs = yield* resolveAntigravityInstanceDirectories(targetStateDir, agyId);
        const restoredToken = yield* fs.readFileString(
          path.join(targetDirs.profile, "antigravity-acp", "antigravity-oauth-token"),
        );
        const restoredInstallId = yield* fs.readFileString(
          path.join(targetDirs.profile, "antigravity-acp", "installation_id"),
        );
        expect(restoredToken).toBe(oauthTokenContent);
        expect(restoredInstallId).toBe(installIdContent);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto))),
  );
});
