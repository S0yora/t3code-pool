import { createAuthenticatedEnvironmentRawFetchCommand } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { HttpMethod } from "effect/http";
import type * as Option from "effect/Option";
import { msg } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { usePreparedConnection } from "../state/session";

let cachedAuthenticatedRawFetch: ReturnType<
  typeof createAuthenticatedEnvironmentRawFetchCommand
> | null = null;

function getAuthenticatedRawFetchCommand() {
  if (cachedAuthenticatedRawFetch === null) {
    cachedAuthenticatedRawFetch =
      createAuthenticatedEnvironmentRawFetchCommand(connectionAtomRuntime);
  }
  return cachedAuthenticatedRawFetch;
}

export type PreparedEnvironmentConnection = Option.Option.Value<
  ReturnType<typeof usePreparedConnection>
>;

export interface DirectSnapshotMeta {
  readonly fingerprint: string;
  readonly poolCount: number;
  readonly accountCount: number;
  readonly credentialCount: number;
  readonly hasSyncableData: boolean;
  readonly isHub: boolean;
}

export interface DirectSyncActionResponse {
  readonly ok: boolean;
  readonly detail: string;
  readonly updatedAtMs?: number;
  readonly fingerprint?: string;
}

const AUTO_SYNC_STORAGE_KEY = "t3code:pool-direct-autosync:enabled";
const FINGERPRINTS_STORAGE_KEY = "t3code:pool-direct-autosync:fingerprints";
const autoSyncListeners = new Set<() => void>();

export function getDirectAutoSyncEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(AUTO_SYNC_STORAGE_KEY);
    if (raw === "false") return false;
    return true;
  } catch {
    return true;
  }
}

export function setDirectAutoSyncEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTO_SYNC_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage errors in restricted contexts.
  }
  for (const listener of autoSyncListeners) {
    listener();
  }
}

export function subscribeDirectAutoSyncEnabled(listener: () => void): () => void {
  autoSyncListeners.add(listener);
  return () => {
    autoSyncListeners.delete(listener);
  };
}

function readFingerprintsMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(FINGERPRINTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export function getLastSyncedFingerprint(
  sourceEnvironmentId: EnvironmentId,
  targetEnvironmentId: EnvironmentId,
): string | null {
  const map = readFingerprintsMap();
  return map[`${sourceEnvironmentId}->${targetEnvironmentId}`] ?? null;
}

export function setLastSyncedFingerprint(
  sourceEnvironmentId: EnvironmentId,
  targetEnvironmentId: EnvironmentId,
  fingerprint: string,
): void {
  try {
    const map = readFingerprintsMap();
    map[`${sourceEnvironmentId}->${targetEnvironmentId}`] = fingerprint;
    window.localStorage.setItem(FINGERPRINTS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors.
  }
}

export async function fetchEnvironmentPoolEndpoint<T>(
  prepared: PreparedEnvironmentConnection | null,
  path: string,
  init?: RequestInit,
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly error?: string;
}> {
  if (!prepared) {
    return { ok: false, status: 0, data: null };
  }
  if (prepared.httpAuthorization?._tag === "Dpop") {
    const method = ((init?.method ?? "GET").toUpperCase() || "GET") as HttpMethod.HttpMethod;
    const body = typeof init?.body === "string" ? init.body : undefined;
    const result = await runAtomCommand(
      appAtomRegistry,
      getAuthenticatedRawFetchCommand(),
      {
        prepared,
        path,
        method,
        ...(body !== undefined ? { body } : {}),
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") {
      const err = squashAtomCommandFailure(result);
      return {
        ok: false,
        status: 0,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    let parsed: T | null = null;
    try {
      parsed = result.value.text ? (JSON.parse(result.value.text) as T) : null;
    } catch {
      parsed = null;
    }
    return {
      ok: result.value.ok,
      status: result.value.status,
      data: parsed,
    };
  }

  const baseUrl = prepared.httpBaseUrl.replace(/\/+$/, "");
  const headers = new Headers(init?.headers);
  if (prepared.httpAuthorization?._tag === "Bearer") {
    headers.set("Authorization", `Bearer ${prepared.httpAuthorization.token}`);
  }
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      credentials: prepared.httpAuthorization === null ? "include" : "omit",
    });
    const text = await response.text();
    let parsed: T | null = null;
    try {
      parsed = text ? (JSON.parse(text) as T) : null;
    } catch {
      parsed = null;
    }
    return { ok: response.ok, status: response.status, data: parsed };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchDirectSnapshotMeta(
  prepared: PreparedEnvironmentConnection | null,
): Promise<DirectSnapshotMeta | null> {
  const res = await fetchEnvironmentPoolEndpoint<DirectSnapshotMeta>(
    prepared,
    "/api/pool-hub/snapshot-meta",
  );
  return res.ok && res.data ? res.data : null;
}

export async function syncProvidersBetweenEnvironments(
  sourcePrepared: PreparedEnvironmentConnection | null,
  targetPrepared: PreparedEnvironmentConnection | null,
): Promise<DirectSyncActionResponse> {
  if (!sourcePrepared || !targetPrepared) {
    return { ok: false, detail: m(msg("Both environments must be connected.")) };
  }
  const exported = await fetchEnvironmentPoolEndpoint<Record<string, unknown>>(
    sourcePrepared,
    "/api/pool-hub/snapshot",
  );
  if (!exported.ok || !exported.data) {
    return {
      ok: false,
      detail:
        exported.status === 404
          ? m(
              msg(
                "Source environment needs to be updated to v0.1.17+ to support direct T3 Connect sync.",
              ),
            )
          : (exported.error ??
            m(msg("Export failed (HTTP {status})."), { status: exported.status })),
    };
  }
  const imported = await fetchEnvironmentPoolEndpoint<DirectSyncActionResponse>(
    targetPrepared,
    "/api/pool-hub/snapshot",
    {
      method: "POST",
      body: JSON.stringify(exported.data),
    },
  );
  if (!imported.ok || !imported.data) {
    return {
      ok: false,
      detail:
        imported.status === 404
          ? m(
              msg(
                "Target environment needs to be updated to v0.1.17+ to support direct T3 Connect sync.",
              ),
            )
          : (imported.error ??
            m(msg("Import failed (HTTP {status})."), { status: imported.status })),
    };
  }
  return imported.data;
}
