import type { ProviderInstanceId, ProviderPoolCooldownRecord } from "@t3tools/contracts";

export interface PoolCooldownState {
  readonly cooldowns: ReadonlyMap<ProviderInstanceId, ProviderPoolCooldownRecord>;
  readonly threadLeases: ReadonlyMap<string, ProviderInstanceId>;
  readonly remoteLeaseCounts: ReadonlyMap<ProviderInstanceId, number>;
  readonly lastSelectedByPool: ReadonlyMap<string, ProviderInstanceId>;
}

export const EMPTY_POOL_COOLDOWN_STATE: PoolCooldownState = {
  cooldowns: new Map(),
  threadLeases: new Map(),
  remoteLeaseCounts: new Map(),
  lastSelectedByPool: new Map(),
};

export function recordMemberCooldown(
  state: PoolCooldownState,
  record: ProviderPoolCooldownRecord,
): PoolCooldownState {
  const existing = state.cooldowns.get(record.instanceId);
  if (
    existing !== undefined &&
    existing.updatedAtMs > record.updatedAtMs &&
    existing.untilMs >= record.untilMs
  ) {
    return state;
  }
  const next = new Map(state.cooldowns);
  next.set(record.instanceId, record);
  return { ...state, cooldowns: next };
}

export function clearExpiredCooldowns(state: PoolCooldownState, nowMs: number): PoolCooldownState {
  let changed = false;
  for (const record of state.cooldowns.values()) {
    if (record.untilMs <= nowMs) {
      changed = true;
      break;
    }
  }
  if (!changed) return state;
  const next = new Map<ProviderInstanceId, ProviderPoolCooldownRecord>();
  for (const [id, record] of state.cooldowns) {
    if (record.untilMs > nowMs) next.set(id, record);
  }
  return { ...state, cooldowns: next };
}

export function isMemberCoolingDown(
  state: PoolCooldownState,
  instanceId: ProviderInstanceId,
  nowMs: number,
): boolean {
  const record = state.cooldowns.get(instanceId);
  return record !== undefined && record.untilMs > nowMs;
}

export function setThreadLease(
  state: PoolCooldownState,
  threadId: string,
  instanceId: ProviderInstanceId,
): PoolCooldownState {
  if (state.threadLeases.get(threadId) === instanceId) return state;
  const next = new Map(state.threadLeases);
  next.set(threadId, instanceId);
  return { ...state, threadLeases: next };
}

export function releaseThreadLease(state: PoolCooldownState, threadId: string): PoolCooldownState {
  if (!state.threadLeases.has(threadId)) return state;
  const next = new Map(state.threadLeases);
  next.delete(threadId);
  return { ...state, threadLeases: next };
}

export function recordPoolSelection(
  state: PoolCooldownState,
  poolId: string,
  instanceId: ProviderInstanceId,
): PoolCooldownState {
  if (state.lastSelectedByPool.get(poolId) === instanceId) return state;
  const next = new Map(state.lastSelectedByPool);
  next.set(poolId, instanceId);
  return { ...state, lastSelectedByPool: next };
}

export function countActiveLeases(
  state: PoolCooldownState,
): ReadonlyMap<ProviderInstanceId, number> {
  const counts = new Map<ProviderInstanceId, number>();
  for (const [id, count] of state.remoteLeaseCounts) {
    if (count > 0) counts.set(id, count);
  }
  for (const instanceId of state.threadLeases.values()) {
    counts.set(instanceId, (counts.get(instanceId) ?? 0) + 1);
  }
  return counts;
}

export function countLocalLeases(
  state: PoolCooldownState,
): Readonly<Record<ProviderInstanceId, number>> {
  const counts: Record<string, number> = {};
  for (const instanceId of state.threadLeases.values()) {
    counts[instanceId] = (counts[instanceId] ?? 0) + 1;
  }
  return counts as Readonly<Record<ProviderInstanceId, number>>;
}

export function mergeRemoteHubState(
  state: PoolCooldownState,
  remoteCooldowns: ReadonlyArray<ProviderPoolCooldownRecord>,
  remoteLeases: Readonly<Record<string, number>>,
  nowMs: number,
): PoolCooldownState {
  let next = clearExpiredCooldowns(state, nowMs);
  for (const record of remoteCooldowns) {
    if (record.untilMs > nowMs) {
      next = recordMemberCooldown(next, record);
    }
  }
  const nextRemoteLeases = new Map<ProviderInstanceId, number>();
  for (const [key, count] of Object.entries(remoteLeases)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      nextRemoteLeases.set(key as ProviderInstanceId, Math.floor(count));
    }
  }
  return { ...next, remoteLeaseCounts: nextRemoteLeases };
}
