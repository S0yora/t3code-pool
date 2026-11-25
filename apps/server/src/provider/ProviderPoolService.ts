import {
  type ModelSelection,
  ProviderInstanceConfig,
  type ProviderInstanceId,
  ProviderPoolConfig,
  ProviderPoolEncryptedBundle,
  ProviderPoolHubReportPayload,
  ProviderPoolHubStatePayload,
  type ProviderPoolId,
  settingsSecretLiteral,
} from "@t3tools/contracts";
import {
  clearExpiredCooldowns,
  countLocalLeases,
  decryptPoolBundle,
  EMPTY_POOL_COOLDOWN_STATE,
  encryptPoolBundle,
  findPoolForInstance,
  mergeRemoteHubState,
  type PoolCooldownState,
  recordMemberCooldown,
  recordPoolSelection,
  releaseThreadLease,
  selectPoolMember,
  setThreadLease,
} from "@t3tools/shared/accountPool";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { resolveAntigravityInstanceDirectories } from "./antigravityAuthSupport.ts";

class PoolHubHttpError extends Schema.TaggedError<PoolHubHttpError>()("PoolHubHttpError", {
  status: Schema.Number,
}) {
  override get message() {
    return `Hub returned HTTP ${this.status}`;
  }
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const HUB_BUNDLE_FILENAME = "pool-hub-bundle.json";

const LOCAL_ONLY_PATH_KEYS = [
  "binaryPath",
  "homePath",
  "shadowHomePath",
  "configPath",
  "executablePath",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Detects filesystem paths belonging to a different OS family so Pull never breaks local CLI resolution. */
function isForeignOsPath(value: string, targetPlatform: NodeJS.Platform): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (targetPlatform === "win32") {
    return trimmed.startsWith("/") || trimmed.startsWith("~/");
  }
  return /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.includes("\\");
}

/**
 * Merges synced provider instances onto a target machine while protecting local OS paths:
 * - Preserves existing local binaryPath/homePath/etc. overrides for instances already configured here.
 * - Drops foreign-OS paths (e.g. C:\... pulled onto Linux/macOS, or /usr/... pulled onto Windows)
 *   so the target machine falls back to its own PATH / default home directory.
 */
export function mergePulledProviderInstances(
  localInstances: Readonly<Record<string, ProviderInstanceConfig>>,
  pulledInstances: Readonly<Record<string, ProviderInstanceConfig>>,
  targetPlatform: NodeJS.Platform,
): Record<ProviderInstanceId, ProviderInstanceConfig> {
  const merged: Record<string, ProviderInstanceConfig> = { ...localInstances };
  for (const [instanceId, pulled] of Object.entries(pulledInstances)) {
    const local = localInstances[instanceId];
    if (!isPlainRecord(pulled.config)) {
      merged[instanceId] = pulled;
      continue;
    }
    const localConfig = isPlainRecord(local?.config) ? local.config : undefined;
    const sanitizedConfig: Record<string, unknown> = { ...pulled.config };
    for (const key of LOCAL_ONLY_PATH_KEYS) {
      const localValue = localConfig?.[key];
      if (typeof localValue === "string" && localValue.trim().length > 0) {
        sanitizedConfig[key] = localValue;
        continue;
      }
      const pulledValue = sanitizedConfig[key];
      if (typeof pulledValue === "string" && isForeignOsPath(pulledValue, targetPlatform)) {
        delete sanitizedConfig[key];
      }
    }
    merged[instanceId] = {
      ...pulled,
      config: sanitizedConfig,
    };
  }
  return merged as Record<ProviderInstanceId, ProviderInstanceConfig>;
}
const HUB_DEVICE_REPORT_TTL_MS = 5 * 60_000;

const ANTIGRAVITY_SYNCED_PROFILE_FILES = [
  "antigravity-acp/antigravity-oauth-token",
  "antigravity-acp/acp_token.json",
  "antigravity-acp/installation_id",
] as const;

const ALLOWED_ANTIGRAVITY_PROFILE_FILES: ReadonlySet<string> = new Set(
  ANTIGRAVITY_SYNCED_PROFILE_FILES,
);

const SyncedCredentialRecordSchema = Schema.Struct({
  namespace: Schema.String,
  bindingId: Schema.String,
  valueBase64: Schema.String,
});
type SyncedCredentialRecord = typeof SyncedCredentialRecordSchema.Type;

const SyncedProfileFileSchema = Schema.Struct({
  driver: Schema.String,
  instanceId: Schema.String,
  relativePath: Schema.String,
  valueBase64: Schema.String,
});
type SyncedProfileFile = typeof SyncedProfileFileSchema.Type;

const PoolVaultPayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  exportedAtMs: Schema.Number,
  providerPools: Schema.Record(Schema.String, ProviderPoolConfig),
  providerInstances: Schema.Record(Schema.String, ProviderInstanceConfig),
  credentials: Schema.Array(SyncedCredentialRecordSchema),
  profileFiles: Schema.optional(Schema.Array(SyncedProfileFileSchema)),
});
type PoolVaultPayload = typeof PoolVaultPayloadSchema.Type;

const PutBundleResponseSchema = Schema.Struct({
  accepted: Schema.optional(Schema.Boolean),
  updatedAtMs: Schema.optional(Schema.Number),
});

const decodeBundleJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ProviderPoolEncryptedBundle),
);
const encodeBundleJson = Schema.encodeSync(Schema.fromJsonString(ProviderPoolEncryptedBundle));
const encodeVaultPayloadJson = Schema.encodeSync(Schema.fromJsonString(PoolVaultPayloadSchema));
const decodeVaultPayloadJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(PoolVaultPayloadSchema),
);

export interface ResolvePoolSelectionInput {
  readonly modelSelection: ModelSelection;
  readonly threadId?: string | undefined;
  readonly preferredInstanceId?: ProviderInstanceId | undefined;
  readonly excludeInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly respectSticky?: boolean | undefined;
}

export interface ResolvePoolSelectionResult {
  readonly modelSelection: ModelSelection;
  readonly poolId: ProviderPoolId | null;
  readonly switched: boolean;
}

export interface PoolSyncResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly updatedAtMs?: number | undefined;
}

export class ProviderPoolService extends Context.Service<
  ProviderPoolService,
  {
    readonly resolveModelSelection: (
      input: ResolvePoolSelectionInput,
    ) => Effect.Effect<ResolvePoolSelectionResult>;
    readonly recordUsageLimit: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly resetAt?: string | null | undefined;
      readonly reason?: string | undefined;
    }) => Effect.Effect<void>;
    readonly releaseThread: (threadId: string) => Effect.Effect<void>;
    readonly getHubState: Effect.Effect<ProviderPoolHubStatePayload>;
    readonly ingestHubReport: (
      report: ProviderPoolHubReportPayload,
    ) => Effect.Effect<ProviderPoolHubStatePayload>;
    readonly getEncryptedBundle: Effect.Effect<ProviderPoolEncryptedBundle | null>;
    readonly putEncryptedBundle: (
      bundle: ProviderPoolEncryptedBundle,
    ) => Effect.Effect<{ readonly accepted: boolean; readonly updatedAtMs: number }>;
    readonly syncNow: Effect.Effect<PoolSyncResult>;
    readonly pushEncryptedBundle: Effect.Effect<PoolSyncResult>;
    readonly pullEncryptedBundle: Effect.Effect<PoolSyncResult>;
  }
>()("t3/provider/ProviderPoolService") {}

interface DeviceReportEntry {
  readonly updatedAtMs: number;
  readonly report: ProviderPoolHubReportPayload;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const secretStoreOption = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const digestOption = yield* Effect.serviceOption(Digest.Digest);
  const random = yield* SecureRandom.SecureRandom;

  const deviceId = yield* random.uuidV4();
  const bundlePath = path.join(config.stateDir, HUB_BUNDLE_FILENAME);
  const stateRef = yield* Ref.make<PoolCooldownState>(EMPTY_POOL_COOLDOWN_STATE);
  const deviceReportsRef = yield* Ref.make<ReadonlyMap<string, DeviceReportEntry>>(new Map());
  const bundleRef = yield* Ref.make<ProviderPoolEncryptedBundle | null>(null);
  const lastAppliedBundleAtRef = yield* Ref.make<number | null>(null);
  const autoPullInFlightRef = yield* Ref.make(false);

  const triggerAutoPull = Effect.fn("ProviderPoolService.triggerAutoPull")(function* () {
    const acquired = yield* Ref.modify(autoPullInFlightRef, (running) =>
      running ? ([false, true] as const) : ([true, true] as const),
    );
    if (!acquired) return;
    yield* pullEncryptedBundle().pipe(
      Effect.ensuring(Ref.set(autoPullInFlightRef, false)),
      Effect.ignore,
      Effect.forkDetach,
    );
  });

  // Hydrate persisted encrypted bundle if running as hub.
  const initialBundleText = yield* fs.readFileString(bundlePath).pipe(Effect.option);
  if (Option.isSome(initialBundleText)) {
    const parsed = decodeBundleJson(initialBundleText.value);
    if (Option.isSome(parsed)) {
      yield* Ref.set(bundleRef, parsed.value);
    }
  }

  const computeHubState = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const localState = yield* Ref.updateAndGet(stateRef, (current) =>
      clearExpiredCooldowns(current, nowMs),
    );
    const deviceReports = yield* Ref.updateAndGet(deviceReportsRef, (current) => {
      let changed = false;
      for (const entry of current.values()) {
        if (nowMs - entry.updatedAtMs > HUB_DEVICE_REPORT_TTL_MS) {
          changed = true;
          break;
        }
      }
      if (!changed) return current;
      const next = new Map<string, DeviceReportEntry>();
      for (const [id, entry] of current) {
        if (nowMs - entry.updatedAtMs <= HUB_DEVICE_REPORT_TTL_MS) {
          next.set(id, entry);
        }
      }
      return next;
    });

    const mergedCooldowns = new Map(localState.cooldowns);
    const activeLeases: Record<string, number> = { ...countLocalLeases(localState) };

    for (const { report } of deviceReports.values()) {
      for (const record of report.cooldowns) {
        if (record.untilMs <= nowMs) continue;
        const existing = mergedCooldowns.get(record.instanceId);
        if (
          existing === undefined ||
          record.updatedAtMs > existing.updatedAtMs ||
          record.untilMs > existing.untilMs
        ) {
          mergedCooldowns.set(record.instanceId, record);
        }
      }
      for (const [instanceId, count] of Object.entries(report.activeLeases)) {
        if (count > 0) {
          activeLeases[instanceId] = (activeLeases[instanceId] ?? 0) + count;
        }
      }
    }

    const bundle = yield* Ref.get(bundleRef);
    return {
      updatedAtMs: nowMs,
      cooldowns: [...mergedCooldowns.values()],
      activeLeases: activeLeases as Readonly<Record<ProviderInstanceId, number>>,
      bundleUpdatedAtMs: bundle?.updatedAtMs ?? null,
    } satisfies ProviderPoolHubStatePayload;
  });

  const syncWithHubInternal = Effect.fn("ProviderPoolService.syncWithHubInternal")(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const sync = settings.providerPoolSync;
    if (!sync.enabled || sync.mode !== "client") {
      return { ok: false, detail: "Hub client sync is disabled." } satisfies PoolSyncResult;
    }
    const baseUrl = sync.hubUrl.trim().replace(/\/+$/, "");
    const token = settingsSecretLiteral(sync.syncToken).trim();
    if (!baseUrl || !token) {
      return {
        ok: false,
        detail: "Hub URL and sync token are required for client sync.",
      } satisfies PoolSyncResult;
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const localState = yield* Ref.updateAndGet(stateRef, (current) =>
      clearExpiredCooldowns(current, nowMs),
    );
    const report: ProviderPoolHubReportPayload = {
      deviceId,
      cooldowns: [...localState.cooldowns.values()],
      activeLeases: countLocalLeases(localState) as Readonly<Record<ProviderInstanceId, number>>,
    };

    const request = yield* HttpClientRequest.post(`${baseUrl}/api/pool-hub/report`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJson(report),
      Effect.result,
    );
    if (Result.isFailure(request)) {
      return {
        ok: false,
        detail: `Failed to serialize hub report: ${String(request.failure)}`,
      } satisfies PoolSyncResult;
    }

    const responseResult = yield* Effect.gen(function* () {
      const res = yield* httpClient.execute(request.success);
      if (res.status < 200 || res.status >= 300) {
        return yield* new PoolHubHttpError({ status: res.status });
      }
      return yield* HttpClientResponse.schemaBodyJson(ProviderPoolHubStatePayload)(res);
    }).pipe(Effect.timeout(Duration.seconds(10)), Effect.result);

    if (Result.isFailure(responseResult)) {
      return {
        ok: false,
        detail:
          responseResult.failure instanceof Error
            ? responseResult.failure.message
            : String(responseResult.failure),
      } satisfies PoolSyncResult;
    }

    yield* Ref.update(stateRef, (current) =>
      mergeRemoteHubState(
        current,
        responseResult.success.cooldowns,
        responseResult.success.activeLeases,
        nowMs,
      ),
    );
    const remoteBundleAt = responseResult.success.bundleUpdatedAtMs;
    if (
      remoteBundleAt !== null &&
      settingsSecretLiteral(sync.syncPassphrase).trim().length > 0
    ) {
      const lastApplied = yield* Ref.get(lastAppliedBundleAtRef);
      if (lastApplied === null || remoteBundleAt > lastApplied) {
        yield* triggerAutoPull();
      }
    }
    return {
      ok: true,
      detail: `Synced ${responseResult.success.cooldowns.length} cooldown(s) from hub.`,
      updatedAtMs: responseResult.success.updatedAtMs,
    } satisfies PoolSyncResult;
  });

  const collectPoolCredentials = Effect.fn("ProviderPoolService.collectPoolCredentials")(function* (
    memberInstanceIds: ReadonlyArray<ProviderInstanceId>,
    providerInstances: Readonly<Record<string, ProviderInstanceConfig>>,
  ) {
    if (Option.isNone(secretStoreOption) || Option.isNone(digestOption)) {
      return [] as ReadonlyArray<SyncedCredentialRecord>;
    }
    const collected: Array<SyncedCredentialRecord> = [];
    for (const instanceId of memberInstanceIds) {
      const configEntry = providerInstances[instanceId];
      if (!configEntry) continue;
      const namespaces =
        configEntry.driver === "codex"
          ? ["codex-chatgpt", "codex-chatgpt-registration"]
          : [configEntry.driver];
      for (const namespace of namespaces) {
        const store = yield* ProviderCredentialStore.make(namespace, instanceId).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secretStoreOption.value),
          Effect.provideService(Digest.Digest, digestOption.value),
        );
        const raw = yield* store.get.pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
        if (Option.isSome(raw)) {
          collected.push({
            namespace,
            bindingId: instanceId,
            valueBase64: Buffer.from(raw.value).toString("base64"),
          });
        }
      }
    }
    return collected;
  });

  const collectPoolProfileFiles = Effect.fn("ProviderPoolService.collectPoolProfileFiles")(
    function* (
      memberInstanceIds: ReadonlyArray<ProviderInstanceId>,
      providerInstances: Readonly<Record<string, ProviderInstanceConfig>>,
    ) {
      if (Option.isNone(digestOption)) {
        return [] as ReadonlyArray<SyncedProfileFile>;
      }
      const collected: Array<SyncedProfileFile> = [];
      for (const instanceId of memberInstanceIds) {
        const configEntry = providerInstances[instanceId];
        if (!configEntry || configEntry.driver !== "antigravity") continue;
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          instanceId,
        ).pipe(
          Effect.provideService(Digest.Digest, digestOption.value),
          Effect.provideService(Path.Path, path),
          Effect.option,
        );
        if (Option.isNone(directories)) continue;
        for (const relativePath of ANTIGRAVITY_SYNCED_PROFILE_FILES) {
          const filePath = path.join(directories.value.profile, ...relativePath.split("/"));
          const raw = yield* fs.readFile(filePath).pipe(Effect.option);
          if (Option.isSome(raw) && raw.value.byteLength > 0) {
            collected.push({
              driver: "antigravity",
              instanceId,
              relativePath,
              valueBase64: Buffer.from(raw.value).toString("base64"),
            });
          }
        }
      }
      return collected;
    },
  );

  const restorePoolProfileFiles = Effect.fn("ProviderPoolService.restorePoolProfileFiles")(
    function* (profileFiles: ReadonlyArray<SyncedProfileFile>, platform: NodeJS.Platform) {
      if (Option.isNone(digestOption) || profileFiles.length === 0) {
        return 0;
      }
      let restored = 0;
      for (const file of profileFiles) {
        if (
          file.driver !== "antigravity" ||
          !ALLOWED_ANTIGRAVITY_PROFILE_FILES.has(file.relativePath)
        ) {
          continue;
        }
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          file.instanceId as ProviderInstanceId,
        ).pipe(
          Effect.provideService(Digest.Digest, digestOption.value),
          Effect.provideService(Path.Path, path),
          Effect.option,
        );
        if (Option.isNone(directories)) continue;
        const targetPath = path.join(directories.value.profile, ...file.relativePath.split("/"));
        yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true }).pipe(Effect.ignore);
        const written = yield* fs
          .writeFile(targetPath, new Uint8Array(Buffer.from(file.valueBase64, "base64")))
          .pipe(Effect.as(true), Effect.orElseSucceed(() => false));
        if (written) {
          if (platform !== "win32") {
            yield* fs.chmod(targetPath, 0o600).pipe(Effect.ignore);
          }
          restored++;
        }
      }
      return restored;
    },
  );

  const putEncryptedBundle = Effect.fn("ProviderPoolService.putEncryptedBundle")(function* (
    bundle: ProviderPoolEncryptedBundle,
  ) {
    yield* Ref.set(bundleRef, bundle);
    yield* fs.makeDirectory(config.stateDir, { recursive: true }).pipe(Effect.ignore);
    yield* fs
      .writeFileString(bundlePath, encodeBundleJson(bundle))
      .pipe(Effect.ignore({ log: true }));
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    if (
      Option.isSome(settings) &&
      settings.value.providerPoolSync.enabled &&
      settings.value.providerPoolSync.mode === "hub" &&
      settingsSecretLiteral(settings.value.providerPoolSync.syncPassphrase).trim().length > 0
    ) {
      const lastApplied = yield* Ref.get(lastAppliedBundleAtRef);
      if (lastApplied === null || bundle.updatedAtMs > lastApplied) {
        yield* triggerAutoPull();
      }
    }
    return { accepted: true, updatedAtMs: bundle.updatedAtMs };
  });

  const pushEncryptedBundle = Effect.fn("ProviderPoolService.pushEncryptedBundle")(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const sync = settings.providerPoolSync;
    const isHub = sync.mode === "hub";
    const baseUrl = sync.hubUrl.trim().replace(/\/+$/, "");
    const token = settingsSecretLiteral(sync.syncToken).trim();
    const passphrase = settingsSecretLiteral(sync.syncPassphrase).trim();
    if (!passphrase) {
      return {
        ok: false,
        detail: "Encryption passphrase is required.",
      } satisfies PoolSyncResult;
    }
    if (!isHub && (!baseUrl || !token)) {
      return {
        ok: false,
        detail: "Hub URL, sync token, and encryption passphrase are all required.",
      } satisfies PoolSyncResult;
    }

    const pooledMemberIds = [
      ...new Set(Object.values(settings.providerPools).flatMap((pool) => pool.memberInstanceIds)),
    ];
    const pooledInstances: Record<string, ProviderInstanceConfig> = {};
    for (const memberId of pooledMemberIds) {
      const instance = settings.providerInstances[memberId];
      if (instance) pooledInstances[memberId] = instance;
    }

    const credentials = sync.syncCredentials
      ? yield* collectPoolCredentials(pooledMemberIds, settings.providerInstances)
      : [];
    const profileFiles = sync.syncCredentials
      ? yield* collectPoolProfileFiles(pooledMemberIds, settings.providerInstances)
      : [];

    const nowMs = yield* Clock.currentTimeMillis;
    const payload: PoolVaultPayload = {
      version: 1,
      exportedAtMs: nowMs,
      providerPools: settings.providerPools,
      providerInstances: pooledInstances,
      credentials,
      ...(profileFiles.length > 0 ? { profileFiles } : {}),
    };

    const plaintextJson = encodeVaultPayloadJson(payload);
    const encrypted = yield* Effect.tryPromise({
      try: () => encryptPoolBundle(plaintextJson, passphrase, nowMs),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(Effect.result);
    if (Result.isFailure(encrypted)) {
      return {
        ok: false,
        detail: `Encryption failed: ${encrypted.failure}`,
      } satisfies PoolSyncResult;
    }

    const totalCredentials = credentials.length + profileFiles.length;
    if (isHub) {
      yield* Ref.set(lastAppliedBundleAtRef, nowMs);
      const stored = yield* putEncryptedBundle(encrypted.success);
      return {
        ok: true,
        detail: `Saved encrypted vault on this Hub with ${Object.keys(settings.providerPools).length} pool(s), ${pooledMemberIds.length} account(s), and ${totalCredentials} credential(s).`,
        updatedAtMs: stored.updatedAtMs,
      } satisfies PoolSyncResult;
    }

    const request = yield* HttpClientRequest.put(`${baseUrl}/api/pool-hub/bundle`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJson(encrypted.success),
      Effect.result,
    );
    if (Result.isFailure(request)) {
      return {
        ok: false,
        detail: `Failed to serialize encrypted bundle: ${String(request.failure)}`,
      } satisfies PoolSyncResult;
    }

    const uploaded = yield* Effect.gen(function* () {
      const res = yield* httpClient.execute(request.success);
      if (res.status < 200 || res.status >= 300) {
        return yield* new PoolHubHttpError({ status: res.status });
      }
      return yield* HttpClientResponse.schemaBodyJson(PutBundleResponseSchema)(res);
    }).pipe(Effect.timeout(Duration.seconds(15)), Effect.result);

    if (Result.isFailure(uploaded)) {
      return {
        ok: false,
        detail:
          uploaded.failure instanceof Error ? uploaded.failure.message : String(uploaded.failure),
      } satisfies PoolSyncResult;
    }
    const pushedUpdatedAtMs = uploaded.success.updatedAtMs ?? nowMs;
    yield* Ref.set(lastAppliedBundleAtRef, pushedUpdatedAtMs);
    return {
      ok: true,
      detail: `Pushed ${Object.keys(settings.providerPools).length} pool(s), ${pooledMemberIds.length} account(s), and ${totalCredentials} credential(s).`,
      updatedAtMs: pushedUpdatedAtMs,
    } satisfies PoolSyncResult;
  });

  const pullEncryptedBundle = Effect.fn("ProviderPoolService.pullEncryptedBundle")(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const sync = settings.providerPoolSync;
    const isHub = sync.mode === "hub";
    const baseUrl = sync.hubUrl.trim().replace(/\/+$/, "");
    const token = settingsSecretLiteral(sync.syncToken).trim();
    const passphrase = settingsSecretLiteral(sync.syncPassphrase).trim();
    if (!passphrase) {
      return {
        ok: false,
        detail: "Encryption passphrase is required.",
      } satisfies PoolSyncResult;
    }
    if (!isHub && (!baseUrl || !token)) {
      return {
        ok: false,
        detail: "Hub URL, sync token, and encryption passphrase are all required.",
      } satisfies PoolSyncResult;
    }

    let bundle: ProviderPoolEncryptedBundle | null = null;
    if (isHub) {
      bundle = yield* Ref.get(bundleRef);
    } else {
      const request = HttpClientRequest.get(`${baseUrl}/api/pool-hub/bundle`).pipe(
        HttpClientRequest.bearerToken(token),
      );
      const downloaded = yield* Effect.gen(function* () {
        const res = yield* httpClient.execute(request);
        if (res.status === 404) {
          return null;
        }
        if (res.status < 200 || res.status >= 300) {
          return yield* new PoolHubHttpError({ status: res.status });
        }
        return yield* HttpClientResponse.schemaBodyJson(ProviderPoolEncryptedBundle)(res);
      }).pipe(Effect.timeout(Duration.seconds(15)), Effect.result);

      if (Result.isFailure(downloaded)) {
        return {
          ok: false,
          detail:
            downloaded.failure instanceof Error
              ? downloaded.failure.message
              : String(downloaded.failure),
        } satisfies PoolSyncResult;
      }
      bundle = downloaded.success;
    }

    if (bundle === null) {
      return {
        ok: false,
        detail: "No encrypted bundle stored on hub yet.",
      } satisfies PoolSyncResult;
    }
    const decryptedText = yield* Effect.tryPromise({
      try: () => decryptPoolBundle(bundle, passphrase),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(Effect.result);

    if (Result.isFailure(decryptedText)) {
      return {
        ok: false,
        detail: "Decryption failed: check your sync passphrase.",
      } satisfies PoolSyncResult;
    }

    const decodedPayload = decodeVaultPayloadJson(decryptedText.success);
    if (Option.isNone(decodedPayload)) {
      return {
        ok: false,
        detail: "Decrypted bundle had an invalid schema.",
      } satisfies PoolSyncResult;
    }

    const payload = decodedPayload.value;
    const platform = yield* HostProcess.Platform;
    const mergedInstances = mergePulledProviderInstances(
      settings.providerInstances,
      payload.providerInstances,
      platform,
    );

    yield* settingsService
      .updateSettings({
        providerInstances: mergedInstances,
        providerPools: payload.providerPools as Record<ProviderPoolId, ProviderPoolConfig>,
      })
      .pipe(Effect.ignore({ log: true }));

    let restoredCredentials = 0;
    if (sync.syncCredentials && Option.isSome(secretStoreOption) && Option.isSome(digestOption)) {
      for (const cred of payload.credentials) {
        const store = yield* ProviderCredentialStore.make(cred.namespace, cred.bindingId).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secretStoreOption.value),
          Effect.provideService(Digest.Digest, digestOption.value),
        );
        yield* store
          .set(new Uint8Array(Buffer.from(cred.valueBase64, "base64")))
          .pipe(Effect.ignore({ log: true }));
        restoredCredentials++;
      }
    }
    const restoredProfileFiles =
      sync.syncCredentials && payload.profileFiles && payload.profileFiles.length > 0
        ? yield* restorePoolProfileFiles(payload.profileFiles, platform)
        : 0;

    yield* Ref.set(lastAppliedBundleAtRef, bundle.updatedAtMs);
    yield* providerRegistry.refresh().pipe(Effect.ignore);

    return {
      ok: true,
      detail: `Imported ${Object.keys(payload.providerPools).length} pool(s), ${Object.keys(payload.providerInstances).length} account(s), and ${restoredCredentials + restoredProfileFiles} credential(s).`,
      updatedAtMs: bundle.updatedAtMs,
    } satisfies PoolSyncResult;
  });

  // Periodic background cooldown/lease sync when configured in client mode.
  yield* Effect.repeat(
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
      if (!settings.providerPoolSync.enabled || settings.providerPoolSync.mode !== "client") {
        return;
      }
      yield* syncWithHubInternal().pipe(Effect.ignore);
    }),
    Schedule.spaced(Duration.seconds(15)),
  ).pipe(forkParked);

  const resolveModelSelection = Effect.fn("ProviderPoolService.resolveModelSelection")(function* (
    input: ResolvePoolSelectionInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const resolved = findPoolForInstance(settings.providerPools, input.modelSelection.instanceId);
    if (!resolved || !resolved.pool.enabled || resolved.pool.memberInstanceIds.length === 0) {
      return {
        modelSelection: input.modelSelection,
        poolId: null,
        switched: false,
      } satisfies ResolvePoolSelectionResult;
    }

    const providers = yield* providerRegistry.getProviders;
    const nowMs = yield* Clock.currentTimeMillis;
    const state = yield* Ref.updateAndGet(stateRef, (current) =>
      clearExpiredCooldowns(current, nowMs),
    );

    const activeLeaseInstanceId = input.threadId
      ? state.threadLeases.get(input.threadId)
      : undefined;
    const candidateStickyId = activeLeaseInstanceId ?? input.preferredInstanceId;
    const stickyInstanceId =
      candidateStickyId !== undefined && resolved.pool.memberInstanceIds.includes(candidateStickyId)
        ? candidateStickyId
        : undefined;
    const decision = selectPoolMember({
      poolId: resolved.poolId,
      pool: resolved.pool,
      preferredInstanceId: stickyInstanceId,
      model: input.modelSelection.model,
      providers,
      cooldownState: state,
      nowMs,
      excludeInstanceIds: input.excludeInstanceIds,
      respectSticky:
        stickyInstanceId !== undefined && (input.respectSticky ?? resolved.pool.stickyThread),
    });

    if (!decision) {
      return {
        modelSelection: input.modelSelection,
        poolId: resolved.poolId,
        switched: false,
      } satisfies ResolvePoolSelectionResult;
    }

    yield* Ref.update(stateRef, (current) => {
      let next = recordPoolSelection(current, resolved.poolId, decision.instanceId);
      if (input.threadId) {
        next = setThreadLease(next, input.threadId, decision.instanceId);
      }
      return next;
    });

    const switched = decision.instanceId !== input.modelSelection.instanceId;
    return {
      modelSelection: switched
        ? { ...input.modelSelection, instanceId: decision.instanceId }
        : input.modelSelection,
      poolId: resolved.poolId,
      switched,
    } satisfies ResolvePoolSelectionResult;
  });

  const recordUsageLimit = Effect.fn("ProviderPoolService.recordUsageLimit")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly resetAt?: string | null | undefined;
    readonly reason?: string | undefined;
  }) {
    const nowMs = yield* Clock.currentTimeMillis;
    const parsedResetMs = input.resetAt ? Date.parse(input.resetAt) : Number.NaN;
    const untilMs =
      Number.isFinite(parsedResetMs) && parsedResetMs > nowMs
        ? parsedResetMs
        : nowMs + DEFAULT_COOLDOWN_MS;
    yield* Ref.update(stateRef, (current) =>
      recordMemberCooldown(current, {
        instanceId: input.instanceId,
        untilMs,
        updatedAtMs: nowMs,
        reason: input.reason ?? "usage_limit",
      }),
    );
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    if (settings.providerPoolSync.enabled && settings.providerPoolSync.mode === "client") {
      yield* syncWithHubInternal().pipe(Effect.ignore, Effect.forkDetach);
    }
  });

  const releaseThread = Effect.fn("ProviderPoolService.releaseThread")(function* (
    threadId: string,
  ) {
    yield* Ref.update(stateRef, (current) => releaseThreadLease(current, threadId));
  });

  const ingestHubReport = Effect.fn("ProviderPoolService.ingestHubReport")(function* (
    report: ProviderPoolHubReportPayload,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* Ref.update(deviceReportsRef, (current) => {
      const next = new Map(current);
      next.set(report.deviceId, { updatedAtMs: nowMs, report });
      return next;
    });
    yield* Ref.update(stateRef, (current) =>
      mergeRemoteHubState(current, report.cooldowns, {}, nowMs),
    );
    return yield* computeHubState;
  });

  return {
    resolveModelSelection,
    recordUsageLimit,
    releaseThread,
    getHubState: computeHubState,
    ingestHubReport,
    getEncryptedBundle: Ref.get(bundleRef),
    putEncryptedBundle,
    syncNow: syncWithHubInternal(),
    pushEncryptedBundle: pushEncryptedBundle(),
    pullEncryptedBundle: pullEncryptedBundle(),
  };
});

export const layer = Layer.effect(ProviderPoolService, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
