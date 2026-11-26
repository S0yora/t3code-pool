import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";

import {
  fetchDirectSnapshotMeta,
  getDirectAutoSyncEnabled,
  getLastSyncedFingerprint,
  type PreparedEnvironmentConnection,
  setLastSyncedFingerprint,
  subscribeDirectAutoSyncEnabled,
  syncProvidersBetweenEnvironments,
} from "../../lib/poolConnectSync";
import { readEnvironment, useConnectedEnvironmentIds } from "../../state/environments";
import { localEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { toastManager } from "../ui/toast";

const AUTO_SYNC_INTERVAL_MS = 60_000;

async function syncSingleHubToLocal(input: {
  readonly hubEnvId: EnvironmentId;
  readonly localEnvironmentId: EnvironmentId;
  readonly hubPrepared: PreparedEnvironmentConnection;
  readonly localPrepared: PreparedEnvironmentConnection;
  readonly localPoolCount: number;
  readonly localAccountCount: number;
  readonly inFlightPairs: Set<string>;
}): Promise<{ readonly source: string; readonly detail: string } | null> {
  const pairKey = `${input.hubEnvId}->${input.localEnvironmentId}`;
  if (input.inFlightPairs.has(pairKey)) return null;
  input.inFlightPairs.add(pairKey);
  try {
    const meta = await fetchDirectSnapshotMeta(input.hubPrepared);
    if (!meta || !meta.hasSyncableData) return null;

    const lastApplied = getLastSyncedFingerprint(input.hubEnvId, input.localEnvironmentId);
    const localLooksEmpty =
      (input.localPoolCount === 0 && meta.poolCount > 0) ||
      (input.localAccountCount === 0 && meta.accountCount > 0);

    if (lastApplied === meta.fingerprint && !localLooksEmpty) {
      return null;
    }

    const result = await syncProvidersBetweenEnvironments(input.hubPrepared, input.localPrepared);
    if (!result.ok) return null;

    setLastSyncedFingerprint(
      input.hubEnvId,
      input.localEnvironmentId,
      result.fingerprint ?? meta.fingerprint,
    );
    return {
      source: readEnvironment(input.hubEnvId)?.label ?? "Hub",
      detail: result.detail,
    };
  } finally {
    input.inFlightPairs.delete(pairKey);
  }
}

/**
 * Automatically pulls provider accounts, pools, and OAuth/Codex credentials from a connected
 * T3 Connect Hub environment onto the local machine whenever the Hub's snapshot changes.
 * Runs directly over existing T3 Connect sessions — no Tailscale, port-forwarding, or Hub URL needed.
 */
export function PoolConnectSyncCoordinator() {
  const gt = useGT();
  const localEnvironmentId = useAtomValue(localEnvironmentIdAtom);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const serverConfigsByEnv = useAtomValue(environmentServerConfigsAtom);
  const autoSyncEnabled = useSyncExternalStore(
    subscribeDirectAutoSyncEnabled,
    getDirectAutoSyncEnabled,
    () => true,
  );
  const inFlightPairsRef = useRef<Set<string>>(new Set());

  const hubIdsKey = connectedEnvironmentIds
    .filter((envId) => {
      if (envId === localEnvironmentId) return false;
      const cfg = serverConfigsByEnv.get(envId);
      return Boolean(
        cfg?.settings.providerPoolSync.enabled && cfg.settings.providerPoolSync.mode === "hub",
      );
    })
    .join(",");

  const runCheck = useEffectEvent(async (_triggerKey: string) => {
    if (!autoSyncEnabled || localEnvironmentId === null) return;
    if (!connectedEnvironmentIds.includes(localEnvironmentId)) return;
    if (!readEnvironmentScope(localEnvironmentId, AuthProvidersManageScope)) return;

    const localConfig = serverConfigsByEnv.get(localEnvironmentId);
    if (!localConfig) return;
    // Never overwrite a machine that is itself configured as a Hub.
    if (
      localConfig.settings.providerPoolSync.enabled &&
      localConfig.settings.providerPoolSync.mode === "hub"
    ) {
      return;
    }

    const localPrepared = readPreparedConnection(localEnvironmentId);
    if (!localPrepared) return;

    const localPoolCount = Object.keys(localConfig.settings.providerPools ?? {}).length;
    const localAccountCount = Object.keys(localConfig.settings.providerInstances ?? {}).length;

    for (const envId of connectedEnvironmentIds) {
      if (envId === localEnvironmentId) continue;
      if (!readEnvironmentScope(envId, AuthProvidersManageScope)) continue;
      const cfg = serverConfigsByEnv.get(envId);
      if (
        !(cfg?.settings.providerPoolSync.enabled && cfg.settings.providerPoolSync.mode === "hub")
      ) {
        continue;
      }
      const hubPrepared = readPreparedConnection(envId);
      if (!hubPrepared) continue;

      const synced = await syncSingleHubToLocal({
        hubEnvId: envId,
        localEnvironmentId,
        hubPrepared,
        localPrepared,
        localPoolCount,
        localAccountCount,
        inFlightPairs: inFlightPairsRef.current,
      });
      if (synced) {
        toastManager.add({
          type: "success",
          title: gt("Synced providers from {source}", { source: synced.source }),
          description: synced.detail,
        });
      }
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls connected T3 Connect Hubs on a timer and mirrors updated provider snapshots onto the local server
  useEffect(() => {
    if (!autoSyncEnabled || localEnvironmentId === null || hubIdsKey.length === 0) return;
    void runCheck(hubIdsKey);
    const timer = window.setInterval(() => {
      void runCheck(hubIdsKey);
    }, AUTO_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [autoSyncEnabled, localEnvironmentId, hubIdsKey]);

  return null;
}
