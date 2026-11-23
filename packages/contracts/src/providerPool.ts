import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

const POOL_ID_MAX_CHARS = 64;
const POOL_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const ProviderPoolId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(POOL_ID_MAX_CHARS),
  Schema.isPattern(POOL_ID_PATTERN),
).pipe(Schema.brand("ProviderPoolId"));
export type ProviderPoolId = typeof ProviderPoolId.Type;

export const ProviderPoolStrategy = Schema.Literals([
  "least_used",
  "earliest_reset",
  "round_robin",
  "priority",
]);
export type ProviderPoolStrategy = typeof ProviderPoolStrategy.Type;

export const ProviderPoolConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  accentColor: Schema.optional(TrimmedNonEmptyString),
  memberInstanceIds: Schema.Array(ProviderInstanceId),
  strategy: ProviderPoolStrategy.pipe(
    Schema.withDecodingDefault(Effect.succeed("least_used" as const)),
  ),
  autoFailover: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  stickyThread: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ProviderPoolConfig = typeof ProviderPoolConfig.Type;

export const ProviderPoolSyncMode = Schema.Literals(["client", "hub"]);
export type ProviderPoolSyncMode = typeof ProviderPoolSyncMode.Type;

export const ProviderPoolSyncSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  mode: ProviderPoolSyncMode.pipe(Schema.withDecodingDefault(Effect.succeed("client" as const))),
  hubUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  syncToken: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  syncPassphrase: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  syncCredentials: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  pollIntervalSeconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 300 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(30)),
  ),
});
export type ProviderPoolSyncSettings = typeof ProviderPoolSyncSettings.Type;

export const ProviderPoolSyncSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  mode: Schema.optionalKey(ProviderPoolSyncMode),
  hubUrl: Schema.optionalKey(TrimmedString),
  syncToken: Schema.optionalKey(SettingsSecretValue),
  syncPassphrase: Schema.optionalKey(SettingsSecretValue),
  syncCredentials: Schema.optionalKey(Schema.Boolean),
  pollIntervalSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 300 })),
  ),
});
export type ProviderPoolSyncSettingsPatch = typeof ProviderPoolSyncSettingsPatch.Type;

export const ProviderPoolCooldownRecord = Schema.Struct({
  instanceId: ProviderInstanceId,
  untilMs: Schema.Number,
  reason: TrimmedString,
  updatedAtMs: Schema.Number,
});
export type ProviderPoolCooldownRecord = typeof ProviderPoolCooldownRecord.Type;

export const ProviderPoolEncryptedBundle = Schema.Struct({
  version: Schema.Literal(1),
  updatedAtMs: Schema.Number,
  saltBase64: TrimmedNonEmptyString,
  ivBase64: TrimmedNonEmptyString,
  ciphertextBase64: TrimmedNonEmptyString,
});
export type ProviderPoolEncryptedBundle = typeof ProviderPoolEncryptedBundle.Type;

export const ProviderPoolHubStatePayload = Schema.Struct({
  updatedAtMs: Schema.Number,
  cooldowns: Schema.Array(ProviderPoolCooldownRecord),
  activeLeases: Schema.Record(ProviderInstanceId, Schema.Int),
  bundleUpdatedAtMs: Schema.NullOr(Schema.Number),
});
export type ProviderPoolHubStatePayload = typeof ProviderPoolHubStatePayload.Type;

export const ProviderPoolHubReportPayload = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  cooldowns: Schema.Array(ProviderPoolCooldownRecord),
  activeLeases: Schema.Record(ProviderInstanceId, Schema.Int),
});
export type ProviderPoolHubReportPayload = typeof ProviderPoolHubReportPayload.Type;
