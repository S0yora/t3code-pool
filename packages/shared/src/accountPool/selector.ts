import {
  isProviderAvailable,
  type ProviderInstanceId,
  type ProviderPoolConfig,
  type ProviderPoolId,
  type ServerProvider,
} from "@t3tools/contracts";
import { exhaustedUsageWindow } from "../usageLimits.ts";
import { countActiveLeases, isMemberCoolingDown, type PoolCooldownState } from "./cooldownStore.ts";

export interface ResolvedPoolEntry {
  readonly poolId: ProviderPoolId;
  readonly pool: ProviderPoolConfig;
}

export interface MemberQuotaAssessment {
  readonly instanceId: ProviderInstanceId;
  readonly available: boolean;
  readonly coolingDown: boolean;
  readonly cooldownUntilMs: number | null;
  readonly exhausted: boolean;
  readonly effectiveRemainingPercent: number;
  readonly earliestResetMs: number | null;
  readonly activeLeases: number;
}

export function findPoolForInstance(
  pools: Readonly<Record<ProviderPoolId, ProviderPoolConfig>>,
  instanceId: ProviderInstanceId,
): ResolvedPoolEntry | null {
  for (const [poolId, pool] of Object.entries(pools) as Array<
    [ProviderPoolId, ProviderPoolConfig]
  >) {
    if (!pool.enabled) continue;
    if (pool.memberInstanceIds.includes(instanceId)) {
      return { poolId, pool };
    }
  }
  return null;
}

function providerSupportsModel(
  provider: Pick<ServerProvider, "models">,
  model: string | undefined,
): boolean {
  const trimmed = model?.trim();
  if (!trimmed || provider.models.length === 0) return true;
  return provider.models.some(
    (entry) => entry.slug === trimmed || (entry.aliases?.includes(trimmed) ?? false),
  );
}

export function unionPoolModels(
  memberModels: ReadonlyArray<ServerProvider["models"]>,
): ServerProvider["models"] {
  const bySlug = new Map<string, ServerProvider["models"][number]>();
  for (const models of memberModels) {
    for (const model of models) {
      if (!bySlug.has(model.slug)) {
        bySlug.set(model.slug, model);
      }
    }
  }
  return [...bySlug.values()];
}

function computeMemberQuotaAssessment(input: {
  readonly provider: ServerProvider | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly cooldownState: PoolCooldownState;
  readonly leaseCounts: ReadonlyMap<ProviderInstanceId, number>;
  readonly nowMs: number;
  readonly model?: string | undefined;
}): MemberQuotaAssessment {
  const { provider, instanceId, cooldownState, leaseCounts, nowMs, model } = input;
  const cooldown = cooldownState.cooldowns.get(instanceId);
  const coolingDown = isMemberCoolingDown(cooldownState, instanceId, nowMs);
  const cooldownUntilMs = coolingDown && cooldown ? cooldown.untilMs : null;
  const activeLeases = leaseCounts.get(instanceId) ?? 0;

  if (
    !provider ||
    !provider.enabled ||
    !provider.installed ||
    provider.auth.status === "unauthenticated" ||
    !isProviderAvailable(provider) ||
    !providerSupportsModel(provider, model)
  ) {
    return {
      instanceId,
      available: false,
      coolingDown,
      cooldownUntilMs,
      exhausted: false,
      effectiveRemainingPercent: 0,
      earliestResetMs: null,
      activeLeases,
    };
  }

  const exhaustedWindow = exhaustedUsageWindow(provider, nowMs, model);
  const windows = provider.usageLimits?.windows ?? [];
  const relevantWindows = windows.filter(
    (window) =>
      (model === undefined || window.modelIds === undefined || window.modelIds.includes(model)) &&
      (model === undefined ||
        window.providerIds === undefined ||
        window.providerIds.includes(model.split("/")[0] ?? "")),
  );

  // Weekly exhaustion blocks the account even if the shorter session window still reports 0% used.
  let effectiveRemainingPercent = 100;
  let earliestResetMs: number | null = null;
  if (exhaustedWindow !== undefined) {
    effectiveRemainingPercent = 0;
  } else if (relevantWindows.length > 0) {
    let minRemaining = 100;
    for (const window of relevantWindows) {
      const rem = Math.max(0, Math.min(100, 100 - (window.usedPercent ?? 0)));
      if (rem < minRemaining) minRemaining = rem;
      if (window.resetsAt) {
        const parsed = Date.parse(window.resetsAt);
        if (Number.isFinite(parsed) && parsed > nowMs) {
          if (earliestResetMs === null || parsed < earliestResetMs) {
            earliestResetMs = parsed;
          }
        }
      }
    }
    effectiveRemainingPercent = minRemaining;
  }

  return {
    instanceId,
    available: true,
    coolingDown,
    cooldownUntilMs,
    exhausted: exhaustedWindow !== undefined,
    effectiveRemainingPercent,
    earliestResetMs,
    activeLeases,
  };
}

export interface SelectPoolMemberInput {
  readonly poolId: ProviderPoolId;
  readonly pool: ProviderPoolConfig;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cooldownState: PoolCooldownState;
  readonly nowMs: number;
  readonly model?: string | undefined;
  readonly preferredInstanceId?: ProviderInstanceId | undefined;
  readonly excludeInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly respectSticky?: boolean | undefined;
}

export interface SelectPoolMemberResult {
  readonly instanceId: ProviderInstanceId;
  readonly assessment: MemberQuotaAssessment;
  readonly switched: boolean;
}

export function selectPoolMember(input: SelectPoolMemberInput): SelectPoolMemberResult | null {
  const {
    poolId,
    pool,
    providers,
    cooldownState,
    nowMs,
    model,
    preferredInstanceId,
    excludeInstanceIds,
  } = input;
  if (!pool.enabled || pool.memberInstanceIds.length === 0) return null;

  const providerById = new Map(providers.map((provider) => [provider.instanceId, provider]));
  const leaseCounts = countActiveLeases(cooldownState);

  const assessments = pool.memberInstanceIds.map((instanceId) =>
    computeMemberQuotaAssessment({
      provider: providerById.get(instanceId),
      instanceId,
      cooldownState,
      leaseCounts,
      nowMs,
      model,
    }),
  );

  const healthy = assessments.filter(
    (item) =>
      item.available &&
      !item.coolingDown &&
      !item.exhausted &&
      !(excludeInstanceIds?.has(item.instanceId) ?? false),
  );

  if (healthy.length === 0) return null;

  const shouldStick =
    (input.respectSticky ?? pool.stickyThread) && preferredInstanceId !== undefined;
  if (shouldStick) {
    const stickyMatch = healthy.find((item) => item.instanceId === preferredInstanceId);
    if (stickyMatch !== undefined) {
      return { instanceId: stickyMatch.instanceId, assessment: stickyMatch, switched: false };
    }
  }

  let chosen: MemberQuotaAssessment;
  switch (pool.strategy) {
    case "priority": {
      chosen = healthy[0]!;
      break;
    }
    case "round_robin": {
      const lastSelected = cooldownState.lastSelectedByPool.get(poolId);
      if (lastSelected === undefined) {
        chosen = healthy[0]!;
      } else {
        const lastIndex = pool.memberInstanceIds.indexOf(lastSelected);
        const ordered =
          lastIndex >= 0
            ? [
                ...pool.memberInstanceIds.slice(lastIndex + 1),
                ...pool.memberInstanceIds.slice(0, lastIndex + 1),
              ]
            : pool.memberInstanceIds;
        const healthyById = new Map(healthy.map((item) => [item.instanceId, item]));
        chosen =
          ordered.map((id) => healthyById.get(id)).find((item) => item !== undefined) ??
          healthy[0]!;
      }
      break;
    }
    case "earliest_reset": {
      chosen = [...healthy].sort((a, b) => {
        const aReset = a.earliestResetMs ?? Number.POSITIVE_INFINITY;
        const bReset = b.earliestResetMs ?? Number.POSITIVE_INFINITY;
        return (
          aReset - bReset ||
          b.effectiveRemainingPercent - a.effectiveRemainingPercent ||
          a.activeLeases - b.activeLeases
        );
      })[0]!;
      break;
    }
    case "least_used":
    default: {
      chosen = [...healthy].sort(
        (a, b) =>
          b.effectiveRemainingPercent - a.effectiveRemainingPercent ||
          a.activeLeases - b.activeLeases ||
          (a.earliestResetMs ?? Number.POSITIVE_INFINITY) -
            (b.earliestResetMs ?? Number.POSITIVE_INFINITY),
      )[0]!;
      break;
    }
  }

  return {
    instanceId: chosen.instanceId,
    assessment: chosen,
    switched: preferredInstanceId !== undefined && chosen.instanceId !== preferredInstanceId,
  };
}

export interface PoolRepresentativeSummary {
  readonly poolId: ProviderPoolId;
  readonly pool: ProviderPoolConfig;
  readonly representativeInstanceId: ProviderInstanceId;
  readonly memberInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly readyCount: number;
  readonly totalCount: number;
}

/**
 * Maps every member instance of an enabled pool to its single representative instance
 * for picker display, preferring the currently active member when healthy or the best member.
 */
export function buildPoolRepresentatives(input: {
  readonly pools: Readonly<Record<ProviderPoolId, ProviderPoolConfig>>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activeInstanceId?: ProviderInstanceId | undefined;
  readonly nowMs: number;
}): {
  readonly byPoolId: ReadonlyMap<ProviderPoolId, PoolRepresentativeSummary>;
  readonly poolByMemberId: ReadonlyMap<ProviderInstanceId, PoolRepresentativeSummary>;
  readonly hiddenMemberIds: ReadonlySet<ProviderInstanceId>;
} {
  const byPoolId = new Map<ProviderPoolId, PoolRepresentativeSummary>();
  const poolByMemberId = new Map<ProviderInstanceId, PoolRepresentativeSummary>();
  const hiddenMemberIds = new Set<ProviderInstanceId>();
  const providerById = new Map(input.providers.map((provider) => [provider.instanceId, provider]));

  for (const [poolId, pool] of Object.entries(input.pools) as Array<
    [ProviderPoolId, ProviderPoolConfig]
  >) {
    if (!pool.enabled) continue;
    const presentMembers = pool.memberInstanceIds.filter((id) => providerById.has(id));
    if (presentMembers.length === 0) continue;

    const readyMembers = presentMembers.filter((id) => {
      const provider = providerById.get(id);
      return (
        provider !== undefined &&
        provider.enabled &&
        provider.installed &&
        provider.auth.status !== "unauthenticated" &&
        isProviderAvailable(provider)
      );
    });

    const preferredInPool =
      input.activeInstanceId !== undefined && presentMembers.includes(input.activeInstanceId)
        ? input.activeInstanceId
        : undefined;

    const selected = selectPoolMember({
      poolId,
      pool: { ...pool, memberInstanceIds: presentMembers },
      providers: input.providers,
      cooldownState: {
        cooldowns: new Map(),
        threadLeases: new Map(),
        remoteLeaseCounts: new Map(),
        lastSelectedByPool: new Map(),
      },
      nowMs: input.nowMs,
      preferredInstanceId: preferredInPool,
      respectSticky: true,
    });

    const representativeInstanceId =
      selected?.instanceId ?? preferredInPool ?? readyMembers[0] ?? presentMembers[0]!;

    const summary: PoolRepresentativeSummary = {
      poolId,
      pool,
      representativeInstanceId,
      memberInstanceIds: presentMembers,
      readyCount: readyMembers.length,
      totalCount: presentMembers.length,
    };
    byPoolId.set(poolId, summary);
    for (const memberId of presentMembers) {
      poolByMemberId.set(memberId, summary);
      if (memberId !== representativeInstanceId) {
        hiddenMemberIds.add(memberId);
      }
    }
  }

  return { byPoolId, poolByMemberId, hiddenMemberIds };
}
