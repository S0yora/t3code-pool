import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { useEnvironmentProviders, useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

// Track instances auto-refreshed in this session so startup checks run once per account.
const attemptedAutoRefreshKeys = new Set<string>();

function autoRefreshKey(environmentId: EnvironmentId, instanceId: ProviderInstanceId): string {
  return `${environmentId}:${instanceId}`;
}

export function clearAutoRefreshAttempt(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): void {
  attemptedAutoRefreshKeys.delete(autoRefreshKey(environmentId, instanceId));
}

function EnvironmentProviderAutoRefreshEffect(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const canRefresh = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const runningRef = useRef(false);

  const pendingInstanceIds =
    settings.autoRefreshProviderStatus && canRefresh
      ? providers
          .filter(
            (provider) =>
              provider.enabled &&
              provider.installed &&
              provider.auth.status === "unknown" &&
              provider.models.length === 0 &&
              !attemptedAutoRefreshKeys.has(autoRefreshKey(environmentId, provider.instanceId)),
          )
          .map((provider) => provider.instanceId)
      : [];

  const pendingKey = pendingInstanceIds.join(",");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- triggers imperative server provider refresh RPC once per session for unchecked accounts
  useEffect(() => {
    if (!pendingKey || runningRef.current) return;
    const targets = pendingKey.split(",") as Array<ProviderInstanceId>;
    for (const instanceId of targets) {
      attemptedAutoRefreshKeys.add(autoRefreshKey(environmentId, instanceId));
    }
    runningRef.current = true;
    let cancelled = false;
    void (async () => {
      for (const instanceId of targets) {
        if (cancelled) break;
        await refreshProviders({
          environmentId,
          input: { instanceId, refreshModels: true, reloadSecrets: true },
        });
      }
    })().finally(() => {
      runningRef.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, pendingKey, refreshProviders]);

  return null;
}

export function ProviderAutoRefreshEffect() {
  const { environments } = useEnvironments();
  const connected = environments.filter((env) => env.connection.phase === "connected");
  return (
    <>
      {connected.map((env) => (
        <EnvironmentProviderAutoRefreshEffect
          key={env.environmentId}
          environmentId={env.environmentId}
        />
      ))}
    </>
  );
}
