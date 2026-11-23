import {
  AuthProvidersManageScope,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderPoolConfig,
  ProviderPoolId,
  type ProviderPoolStrategy,
  type ProviderPoolSyncMode,
  type ServerProvider,
  type UnifiedSettings,
  isSecretReference,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  CloudDownloadIcon,
  CloudUploadIcon,
  LayersIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface PoolStatusCooldown {
  readonly instanceId: ProviderInstanceId;
  readonly untilMs: number;
  readonly reason: string;
  readonly updatedAtMs: number;
}

interface PoolStatusPayload {
  readonly updatedAtMs: number;
  readonly cooldowns: ReadonlyArray<PoolStatusCooldown>;
  readonly activeLeases: Readonly<Record<string, number>>;
  readonly bundleUpdatedAtMs: number | null;
}

interface PoolSyncActionResponse {
  readonly ok: boolean;
  readonly detail: string;
  readonly updatedAtMs?: number;
}

const POOL_STRATEGIES: ReadonlyArray<{
  readonly value: ProviderPoolStrategy;
  readonly label: string;
}> = [
  { value: "least_used", label: msg("Least used quota") },
  { value: "earliest_reset", label: msg("Earliest reset") },
  { value: "round_robin", label: msg("Round robin") },
  { value: "priority", label: msg("Priority order") },
];

function isConfiguredSecret(value: unknown): boolean {
  if (isSecretReference(value)) return true;
  return typeof value === "string" && value.trim().length > 0;
}

function makePoolId(
  displayName: string,
  driver: ProviderDriverKind,
  existing: Readonly<Record<string, ProviderPoolConfig>>,
): ProviderPoolId {
  const raw = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
  const base = raw || `${String(driver).replace(/[^a-zA-Z0-9_-]/g, "")}-pool`;
  if (!Object.hasOwn(existing, base)) {
    return ProviderPoolId.make(base);
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 56)}-${i}`;
    if (!Object.hasOwn(existing, candidate)) {
      return ProviderPoolId.make(candidate);
    }
  }
  return ProviderPoolId.make(`pool-${Date.now()}`);
}

function driverLabel(driver: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES] ?? String(driver);
}

function formatCooldownRemaining(untilMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.round((untilMs - nowMs) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

async function fetchEnvironmentPoolEndpoint<T>(
  prepared: Option.Option.Value<ReturnType<typeof usePreparedConnection>> | null,
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

export function ProviderPoolsSettings({
  environmentId,
  environmentLabel,
  settings,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const editable = !readOnly && canManageProviders;

  const pools = settings.providerPools ?? {};
  const sync = settings.providerPoolSync;
  const poolEntries = Object.entries(pools) as Array<[ProviderPoolId, ProviderPoolConfig]>;

  const [editingPool, setEditingPool] = useState<{
    readonly poolId: ProviderPoolId | null;
  } | null>(null);
  const [status, setStatus] = useState<PoolStatusPayload | null>(null);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const [busyAction, setBusyAction] = useState<"sync" | "push" | "pull" | null>(null);

  const refreshStatus = async () => {
    if (!prepared) return;
    setIsRefreshingStatus(true);
    const res = await fetchEnvironmentPoolEndpoint<PoolStatusPayload>(
      prepared,
      "/api/pool-hub/status",
      { method: "GET" },
    );
    setIsRefreshingStatus(false);
    if (res.ok && res.data) {
      setStatus(res.data);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads initial live cooldown & lease status from the connected server
  useEffect(() => {
    if (!prepared) return;
    let cancelled = false;
    void fetchEnvironmentPoolEndpoint<PoolStatusPayload>(prepared, "/api/pool-hub/status", {
      method: "GET",
    }).then((res) => {
      if (!cancelled && res.ok && res.data) {
        setStatus(res.data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [prepared]);

  const allAccounts = (() => {
    const map = new Map<
      ProviderInstanceId,
      {
        readonly instanceId: ProviderInstanceId;
        readonly driver: ProviderDriverKind;
        readonly label: string;
        readonly status: string;
        readonly enabled: boolean;
      }
    >();
    for (const provider of providers) {
      map.set(provider.instanceId, {
        instanceId: provider.instanceId,
        driver: provider.driver,
        label: provider.displayName?.trim() || provider.auth.email?.trim() || provider.instanceId,
        status: provider.status,
        enabled: provider.enabled,
      });
    }
    for (const [id, cfg] of Object.entries(settings.providerInstances ?? {}) as Array<
      [ProviderInstanceId, ProviderInstanceConfig]
    >) {
      if (!map.has(id)) {
        map.set(id, {
          instanceId: id,
          driver: cfg.driver,
          label: cfg.displayName?.trim() || id,
          status: "unknown",
          enabled: cfg.enabled !== false,
        });
      }
    }
    return [...map.values()];
  })();

  const pooledMemberSet = new Set<ProviderInstanceId>();
  for (const [, pool] of poolEntries) {
    for (const id of pool.memberInstanceIds) {
      pooledMemberSet.add(id);
    }
  }

  const quickPoolSuggestions = (() => {
    const byDriver = new Map<ProviderDriverKind, Array<ProviderInstanceId>>();
    for (const account of allAccounts) {
      if (!account.enabled || pooledMemberSet.has(account.instanceId)) continue;
      const list = byDriver.get(account.driver) ?? [];
      list.push(account.instanceId);
      byDriver.set(account.driver, list);
    }
    return [...byDriver.entries()].filter(([, ids]) => ids.length >= 2);
  })();

  const runSyncAction = async (action: "sync" | "push" | "pull") => {
    if (!prepared || busyAction !== null) return;
    setBusyAction(action);
    const res = await fetchEnvironmentPoolEndpoint<PoolSyncActionResponse>(
      prepared,
      "/api/pool-hub/sync",
      {
        method: "POST",
        body: JSON.stringify({ action }),
      },
    );
    setBusyAction(null);
    const detail =
      res.data?.detail ??
      res.error ??
      (res.ok
        ? gt("Completed.")
        : res.status === 0
          ? gt("Environment is not connected.")
          : gt("Request failed (HTTP {status}).", { status: res.status }));
    toastManager.add({
      type: res.ok && res.data?.ok !== false ? "success" : "error",
      title:
        action === "push"
          ? gt("Push encrypted vault")
          : action === "pull"
            ? gt("Pull encrypted vault")
            : gt("Pool hub sync"),
      description: detail,
    });
    if (res.ok) {
      void refreshStatus();
    }
  };

  const statusNowMs = status?.updatedAtMs ?? 0;
  const activeCooldownByInstance = new Map<ProviderInstanceId, PoolStatusCooldown>();
  for (const record of status?.cooldowns ?? []) {
    if (record.untilMs > statusNowMs) {
      activeCooldownByInstance.set(record.instanceId, record);
    }
  }

  const activeLeases = status?.activeLeases ?? {};
  const tokenConfigured = isConfiguredSecret(sync.syncToken);
  const passphraseConfigured = isConfiguredSecret(sync.syncPassphrase);

  return (
    <>
      <SettingsSection
        title={gt("Account pools")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={isRefreshingStatus || !prepared}
              onClick={() => void refreshStatus()}
              aria-label={gt("Refresh pool status")}
            >
              <RefreshCwIcon
                className={isRefreshingStatus ? "size-3 animate-spin" : "size-3"}
                aria-hidden
              />
              <T>Status</T>
            </Button>
            {editable ? (
              <Button size="xs" variant="outline" onClick={() => setEditingPool({ poolId: null })}>
                <PlusIcon className="size-3" aria-hidden />
                <T>Add pool</T>
              </Button>
            ) : null}
          </div>
        }
      >
        {editable && quickPoolSuggestions.length > 0
          ? quickPoolSuggestions.map(([driver, ids]) => (
              <SettingsRow
                key={`suggest-${driver}`}
                title={
                  <span className="inline-flex items-center gap-2">
                    <LayersIcon className="size-3.5 text-muted-foreground" aria-hidden />
                    {gt("{count} unpooled {driver} accounts detected", {
                      count: ids.length,
                      driver: driverLabel(driver),
                    })}
                  </span>
                }
                description={gt(
                  "Group them into a single agent entry with automatic least-used routing and quota failover.",
                )}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      const displayName = `${driverLabel(driver)} Pool`;
                      const poolId = makePoolId(displayName, driver, pools);
                      updateSettings({
                        providerPools: {
                          [poolId]: {
                            driver,
                            displayName,
                            memberInstanceIds: ids,
                            strategy: "least_used",
                            autoFailover: true,
                            stickyThread: true,
                            enabled: true,
                          },
                        },
                      });
                      toastManager.add({
                        type: "success",
                        title: gt("Account pool created"),
                        description: gt("{name} now combines {count} accounts.", {
                          name: displayName,
                          count: ids.length,
                        }),
                      });
                    }}
                  >
                    <T>Create pool</T>
                  </Button>
                }
              />
            ))
          : null}

        {poolEntries.length === 0 ? (
          <SettingsRow
            title={gt("No account pools configured.")}
            description={gt(
              "Add multiple accounts for Codex, Antigravity, or Claude above, then combine them into a pool.",
            )}
          />
        ) : (
          poolEntries.map(([poolId, pool]) => {
            const members = pool.memberInstanceIds.map((id) =>
              allAccounts.find((account) => account.instanceId === id),
            );
            const readyCount = members.filter(
              (member) =>
                member !== undefined &&
                member.enabled &&
                member.status === "ready" &&
                !activeCooldownByInstance.has(member.instanceId),
            ).length;
            const cooldownMembers = pool.memberInstanceIds
              .map((id) => activeCooldownByInstance.get(id))
              .filter((c): c is PoolStatusCooldown => c !== undefined);
            const poolActiveLeases = pool.memberInstanceIds.reduce(
              (sum, id) => sum + (activeLeases[id] ?? 0),
              0,
            );
            const strategyEntry = POOL_STRATEGIES.find((item) => item.value === pool.strategy);
            const strategyLabel = strategyEntry ? m(strategyEntry.label) : pool.strategy;

            return (
              <SettingsRow
                key={poolId}
                title={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span>{pool.displayName}</span>
                    <Badge variant="outline" size="sm">
                      {driverLabel(pool.driver)}
                    </Badge>
                    <Badge variant={readyCount > 0 ? "secondary" : "destructive"} size="sm">
                      {gt("{ready}/{total} ready", {
                        ready: readyCount,
                        total: pool.memberInstanceIds.length,
                      })}
                    </Badge>
                    {poolActiveLeases > 0 ? (
                      <Badge variant="outline" size="sm">
                        {gt("{count} active", { count: poolActiveLeases })}
                      </Badge>
                    ) : null}
                  </span>
                }
                description={
                  <span className="flex flex-col gap-1">
                    <span>
                      {strategyLabel}
                      {pool.autoFailover ? ` · ${gt("Auto-failover")}` : ""}
                      {pool.stickyThread ? ` · ${gt("Sticky threads")}` : ""}
                    </span>
                    {cooldownMembers.length > 0 ? (
                      <span className="text-xs text-warning-foreground">
                        {gt("Cooldown: {details}", {
                          details: cooldownMembers
                            .map(
                              (c) =>
                                `${c.instanceId} (${formatCooldownRemaining(c.untilMs, statusNowMs)})`,
                            )
                            .join(", "),
                        })}
                      </span>
                    ) : null}
                  </span>
                }
                control={
                  <div className="flex items-center gap-1.5">
                    {editable ? (
                      <>
                        <Switch
                          checked={pool.enabled}
                          aria-label={gt("Enable {name}", { name: pool.displayName })}
                          onCheckedChange={(checked) =>
                            updateSettings({
                              providerPools: {
                                [poolId]: { ...pool, enabled: checked },
                              },
                            })
                          }
                        />
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={gt("Edit {name}", { name: pool.displayName })}
                          onClick={() => setEditingPool({ poolId })}
                        >
                          <PencilIcon className="size-3.5" aria-hidden />
                        </Button>
                        <RemovePoolButton
                          label={pool.displayName}
                          onConfirm={() => updateSettings({ providerPools: { [poolId]: null } })}
                        />
                      </>
                    ) : null}
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      <SettingsSection title={gt("Multi-device pool sync & encrypted vault")}>
        <SettingsRow
          title={gt("Enable pool sync")}
          description={gt(
            "Run {environment} as a central Hub (for example on your always-on server) or as a Client that syncs cooldowns and encrypted vaults with the Hub.",
            { environment: environmentLabel },
          )}
          control={
            <Switch
              checked={sync.enabled}
              disabled={!editable}
              onCheckedChange={(checked) =>
                updateSettings({ providerPoolSync: { enabled: checked } })
              }
            />
          }
        />

        {sync.enabled ? (
          <>
            <SettingsRow
              title={gt("Sync role")}
              description={
                sync.mode === "hub"
                  ? gt(
                      "Serves /api/pool-hub/* for your other machines and stores the encrypted vault.",
                    )
                  : gt("Periodically exchanges cooldowns and leases with your Hub server.")
              }
              control={
                <Select
                  value={sync.mode}
                  disabled={!editable}
                  onValueChange={(value) => {
                    if (value === "hub" || value === "client") {
                      updateSettings({
                        providerPoolSync: { mode: value as ProviderPoolSyncMode },
                      });
                    }
                  }}
                >
                  <SelectTrigger className="w-40" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup align="end">
                    <SelectItem value="hub">{gt("Hub (central server)")}</SelectItem>
                    <SelectItem value="client">{gt("Client (sync to hub)")}</SelectItem>
                  </SelectPopup>
                </Select>
              }
            />

            {sync.mode === "client" ? (
              <SettingsRow
                title={gt("Hub URL")}
                description={gt("Base HTTP/HTTPS URL of your central T3 Code Hub server.")}
                control={
                  <DraftInput
                    size="sm"
                    className="w-64"
                    disabled={!editable}
                    placeholder="https://my-server.ts.net:3773"
                    value={sync.hubUrl}
                    onCommit={(next) =>
                      updateSettings({ providerPoolSync: { hubUrl: next.trim() } })
                    }
                  />
                }
              />
            ) : null}

            <SettingsRow
              title={gt("Sync bearer token")}
              description={gt("Shared secret authenticating clients against the Hub API.")}
              control={
                <div className="flex items-center gap-1.5">
                  <SecretInput
                    size="sm"
                    className="w-56"
                    disabled={!editable}
                    configured={tokenConfigured}
                    value=""
                    onCommit={(next) => updateSettings({ providerPoolSync: { syncToken: next } })}
                  />
                  {editable && tokenConfigured ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={gt("Clear sync token")}
                      onClick={() => updateSettings({ providerPoolSync: { syncToken: "" } })}
                    >
                      <XIcon className="size-3.5" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              }
            />

            <SettingsRow
              title={gt("Vault encryption passphrase")}
              description={gt(
                "Used locally for AES-256-GCM encryption before pushing or after pulling account bundles. Never sent in plaintext.",
              )}
              control={
                <div className="flex items-center gap-1.5">
                  <SecretInput
                    size="sm"
                    className="w-56"
                    disabled={!editable}
                    configured={passphraseConfigured}
                    value=""
                    onCommit={(next) =>
                      updateSettings({ providerPoolSync: { syncPassphrase: next } })
                    }
                  />
                  {editable && passphraseConfigured ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={gt("Clear vault passphrase")}
                      onClick={() => updateSettings({ providerPoolSync: { syncPassphrase: "" } })}
                    >
                      <XIcon className="size-3.5" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              }
            />

            <SettingsRow
              title={gt("Include account credentials in vault")}
              description={gt(
                "Encrypt and sync stored provider tokens (Codex, Claude, etc.) alongside pool configuration.",
              )}
              control={
                <Switch
                  checked={sync.syncCredentials}
                  disabled={!editable}
                  onCheckedChange={(checked) =>
                    updateSettings({ providerPoolSync: { syncCredentials: checked } })
                  }
                />
              }
            />

            <SettingsRow
              title={sync.mode === "hub" ? gt("Hub vault actions") : gt("Vault & cooldown actions")}
              description={
                status?.bundleUpdatedAtMs
                  ? gt("Encrypted bundle stored at {time} · {cooldowns} active cooldown(s).", {
                      time: new Date(status.bundleUpdatedAtMs).toLocaleString(),
                      cooldowns: activeCooldownByInstance.size,
                    })
                  : sync.mode === "hub"
                    ? gt(
                        "Push pools and accounts from this Hub into the encrypted vault so client devices can pull them.",
                      )
                    : gt("Push accounts from your primary device, then pull on any other device.")
              }
              control={
                <div className="flex flex-wrap items-center gap-1.5">
                  {sync.mode === "client" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!editable || busyAction !== null}
                      onClick={() => void runSyncAction("sync")}
                    >
                      <RefreshCwIcon
                        className={busyAction === "sync" ? "size-3 animate-spin" : "size-3"}
                        aria-hidden
                      />
                      <T>Sync now</T>
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!editable || busyAction !== null}
                    onClick={() => void runSyncAction("push")}
                  >
                    <CloudUploadIcon className="size-3" aria-hidden />
                    <T>Push vault</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!editable || busyAction !== null}
                    onClick={() => void runSyncAction("pull")}
                  >
                    <CloudDownloadIcon className="size-3" aria-hidden />
                    <T>Pull vault</T>
                  </Button>
                </div>
              }
            />
          </>
        ) : null}
      </SettingsSection>

      {editingPool && editable ? (
        <PoolEditorDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingPool(null);
          }}
          poolId={editingPool.poolId}
          existingPool={editingPool.poolId ? pools[editingPool.poolId] : undefined}
          existingPools={pools}
          allAccounts={allAccounts}
          onSave={(poolId, config) => {
            updateSettings({ providerPools: { [poolId]: config } });
            setEditingPool(null);
          }}
        />
      ) : null}
    </>
  );
}

function RemovePoolButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={gt("Remove pool {name}", { name: label })}
      >
        <Trash2Icon className="size-3.5" aria-hidden />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove pool <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                The underlying provider accounts are kept untouched and will appear individually in
                the model picker again.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                onConfirm();
                setOpen(false);
              }}
            >
              <T>Remove pool</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function PoolEditorDialog({
  open,
  onOpenChange,
  poolId,
  existingPool,
  existingPools,
  allAccounts,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly poolId: ProviderPoolId | null;
  readonly existingPool: ProviderPoolConfig | undefined;
  readonly existingPools: Readonly<Record<string, ProviderPoolConfig>>;
  readonly allAccounts: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly label: string;
    readonly status: string;
    readonly enabled: boolean;
  }>;
  readonly onSave: (poolId: ProviderPoolId, config: ProviderPoolConfig) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const formId = useId();
  const availableDrivers = (() => {
    const set = new Set<ProviderDriverKind>();
    for (const acc of allAccounts) set.add(acc.driver);
    if (existingPool) set.add(existingPool.driver);
    return [...set];
  })();

  const [driver, setDriver] = useState<ProviderDriverKind>(
    existingPool?.driver ?? availableDrivers[0] ?? ProviderDriverKind.make("codex"),
  );
  const [displayName, setDisplayName] = useState(
    existingPool?.displayName ?? `${driverLabel(driver)} Pool`,
  );
  const [selectedMembers, setSelectedMembers] = useState<Array<ProviderInstanceId>>(() =>
    existingPool
      ? [...existingPool.memberInstanceIds]
      : allAccounts.filter((a) => a.driver === driver && a.enabled).map((a) => a.instanceId),
  );
  const [strategy, setStrategy] = useState<ProviderPoolStrategy>(
    existingPool?.strategy ?? "least_used",
  );
  const [autoFailover, setAutoFailover] = useState(existingPool?.autoFailover ?? true);
  const [stickyThread, setStickyThread] = useState(existingPool?.stickyThread ?? true);

  const driverAccounts = allAccounts.filter((account) => account.driver === driver);

  const toggleMember = (instanceId: ProviderInstanceId) => {
    setSelectedMembers((current) =>
      current.includes(instanceId)
        ? current.filter((id) => id !== instanceId)
        : [...current, instanceId],
    );
  };

  const canSave = displayName.trim().length > 0 && selectedMembers.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existingPool ? gt("Edit account pool") : gt("Create account pool")}
          </DialogTitle>
          <DialogDescription>
            <T>
              Selected accounts will collapse into a single agent in the model picker and share load
              automatically.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave) return;
              const resolvedId = poolId ?? makePoolId(displayName.trim(), driver, existingPools);
              onSave(resolvedId, {
                driver,
                displayName: displayName.trim(),
                ...(existingPool?.accentColor ? { accentColor: existingPool.accentColor } : {}),
                memberInstanceIds: selectedMembers,
                strategy,
                autoFailover,
                stickyThread,
                enabled: existingPool?.enabled ?? true,
              });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="pool-display-name">
                <T>Pool display name</T>
              </Label>
              <Input
                id="pool-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={gt("e.g. Antigravity Pool")}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>
                  <T>Provider</T>
                </Label>
                <Select
                  value={driver}
                  disabled={existingPool !== undefined}
                  onValueChange={(next) => {
                    if (!next) return;
                    const nextDriver = next as ProviderDriverKind;
                    setDriver(nextDriver);
                    setDisplayName(`${driverLabel(nextDriver)} Pool`);
                    setSelectedMembers(
                      allAccounts
                        .filter((a) => a.driver === nextDriver && a.enabled)
                        .map((a) => a.instanceId),
                    );
                  }}
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {availableDrivers.map((item) => (
                      <SelectItem key={item} value={item}>
                        {driverLabel(item)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              <div className="grid gap-1.5">
                <Label>
                  <T>Routing strategy</T>
                </Label>
                <Select
                  value={strategy}
                  onValueChange={(next) => {
                    if (next) setStrategy(next as ProviderPoolStrategy);
                  }}
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {POOL_STRATEGIES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {m(item.label)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>
                  <T>
                    Member accounts (<Var>{selectedMembers.length}</Var>)
                  </T>
                </Label>
                {driverAccounts.length > 0 ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      setSelectedMembers(
                        selectedMembers.length === driverAccounts.length
                          ? []
                          : driverAccounts.map((a) => a.instanceId),
                      )
                    }
                  >
                    {selectedMembers.length === driverAccounts.length
                      ? gt("Clear all")
                      : gt("Select all")}
                  </Button>
                ) : null}
              </div>

              {driverAccounts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  <T>No accounts found for this provider yet.</T>
                </p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/70 p-2">
                  {driverAccounts.map((account) => {
                    const checked = selectedMembers.includes(account.instanceId);
                    return (
                      <label
                        key={account.instanceId}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/40"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMember(account.instanceId)}
                            className="size-3.5 accent-primary"
                          />
                          <span className="truncate">{account.label}</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {account.instanceId}
                          </span>
                        </span>
                        <Badge
                          variant={account.status === "ready" ? "secondary" : "outline"}
                          size="sm"
                        >
                          {account.status}
                        </Badge>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="grid gap-2.5 pt-1">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="block font-medium">
                    <T>Auto-failover on quota / rate limit</T>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <T>Automatically switch to another healthy account and resume the run.</T>
                  </span>
                </span>
                <Switch checked={autoFailover} onCheckedChange={setAutoFailover} />
              </label>

              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="block font-medium">
                    <T>Sticky thread affinity</T>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <T>Keep a thread on the same account to preserve cache until quota runs out.</T>
                  </span>
                </span>
                <Switch checked={stickyThread} onCheckedChange={setStickyThread} />
              </label>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" form={formId} disabled={!canSave}>
            {existingPool ? gt("Save pool") : gt("Create pool")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
