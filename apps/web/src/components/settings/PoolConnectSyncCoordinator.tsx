import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";

import {
  fetchDirectSnapshotMeta,
  getDirectAutoSyncEnabled,
  getLastSyncedFingerprint,
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

    const hubCandidates: Array<EnvironmentId> = [];
    for (const envId of connectedEnvironmentIds) {
      if (envId === localEnvironmentId) continue;
      if (!readEnvironmentScope(envId, AuthProvidersManageScope)) continue;
      const cfg = serverConfigsByEnv.get(envId);
      if (cfg?.settings.providerPoolSync.enabled && cfg.settings.providerPoolSync.mode === "hub") {
        hubCandidates.push(envId);
      }
    }

    for (const hubEnvId of hubCandidates) {
      const pairKey = `${hubEnvId}->${localEnvironmentId}`;
      if (inFlightPairsRef.current.has(pairKey)) continue;

      const hubPrepared = readPreparedConnection(hubEnvId);
      if (!hubPrepared) continue;

      inFlightPairsRef.current.add(pairKey);
      try {
        const meta = await fetchDirectSnapshotMeta(hubPrepared);
        if (!meta || !meta.hasSyncableData) continue;

        const lastApplied = getLastSyncedFingerprint(hubEnvId, localEnvironmentId);
        const localPoolCount = Object.keys(localConfig.settings.providerPools ?? {}).length;
        const localAccountCount = Object.keys(localConfig.settings.providerInstances ?? {}).length;
        const localLooksEmpty =
          (localPoolCount === 0 && meta.poolCount > 0) ||
          (localAccountCount === 0 && meta.accountCount > 0);

        if (lastApplied === meta.fingerprint && !localLooksEmpty) {
          continue;
        }

        const result = await syncProvidersBetweenEnvironments(hubPrepared, localPrepared);
        if (result.ok) {
          setLastSyncedFingerprint(
            hubEnvId,
            localEnvironmentId,
            result.fingerprint ?? meta.fingerprint,
          );
          const hubLabel = readEnvironment(hubEnvId)?.label ?? "Hub";
          toastManager.add({
            type: "success",
            title: gt("Synced providers from {source}", { source: hubLabel }),
            description: result.detail,
          });
        }
      } finally {
        inFlightPairsRef.current.delete(pairKey);
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
