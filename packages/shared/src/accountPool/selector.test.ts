import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderPoolId,
  type ProviderPoolConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  EMPTY_POOL_COOLDOWN_STATE,
  recordMemberCooldown,
  recordPoolSelection,
  setThreadLease,
} from "./cooldownStore.ts";
import { buildPoolRepresentatives, selectPoolMember } from "./selector.ts";

function makeProvider(
  id: string,
  opts: {
    usedPercent?: number;
    weeklyUsedPercent?: number;
    resetsAt?: string;
    enabled?: boolean;
    authStatus?: "authenticated" | "unauthenticated";
    models?: ReadonlyArray<{ readonly slug: string; readonly aliases?: ReadonlyArray<string> }>;
  } = {},
): ServerProvider {
  const windows = [];
  if (opts.usedPercent !== undefined) {
    windows.push({
      id: "primary",
      kind: "session" as const,
      label: "5h session",
      usedPercent: opts.usedPercent,
      ...(opts.resetsAt ? { resetsAt: opts.resetsAt } : {}),
    });
  }
  if (opts.weeklyUsedPercent !== undefined) {
    windows.push({
      id: "secondary",
      kind: "weekly" as const,
      label: "Weekly",
      usedPercent: opts.weeklyUsedPercent,
    });
  }
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: opts.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: opts.authStatus ?? "authenticated" },
    checkedAt: "2026-11-23T12:00:00.000Z",
    models: (opts.models ?? []).map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      capabilities: null,
      ...(model.aliases ? { aliases: model.aliases } : {}),
    })),
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-23T12:00:00.000Z",
      windows,
    },
  } as unknown as ServerProvider;
}

const POOL_ID = ProviderPoolId.make("chatgpt-pool");

function makePool(overrides: Partial<ProviderPoolConfig> = {}): ProviderPoolConfig {
  return {
    driver: ProviderDriverKind.make("codex"),
    displayName: "ChatGPT Pool",
    memberInstanceIds: [
      ProviderInstanceId.make("codex_1"),
      ProviderInstanceId.make("codex_2"),
      ProviderInstanceId.make("codex_3"),
    ],
    strategy: "least_used",
    autoFailover: true,
    stickyThread: true,
    enabled: true,
    ...overrides,
  };
}

describe("selectPoolMember", () => {
  const nowMs = Date.parse("2026-11-23T12:00:00.000Z");

  it("picks least used member and skips weekly-exhausted accounts", () => {
    const providers = [
      makeProvider("codex_1", { usedPercent: 0, weeklyUsedPercent: 100 }),
      makeProvider("codex_2", { usedPercent: 60, weeklyUsedPercent: 30 }),
      makeProvider("codex_3", { usedPercent: 20, weeklyUsedPercent: 15 }),
    ];
    const selected = selectPoolMember({
      poolId: POOL_ID,
      pool: makePool(),
      providers,
      cooldownState: EMPTY_POOL_COOLDOWN_STATE,
      nowMs,
    });
    expect(selected?.instanceId).toBe(ProviderInstanceId.make("codex_3"));
  });

  it("preserves sticky thread affinity while current member is healthy", () => {
    const providers = [
      makeProvider("codex_1", { usedPercent: 75 }),
      makeProvider("codex_2", { usedPercent: 10 }),
    ];
    const selected = selectPoolMember({
      poolId: POOL_ID,
      pool: makePool({
        memberInstanceIds: [ProviderInstanceId.make("codex_1"), ProviderInstanceId.make("codex_2")],
      }),
      providers,
      cooldownState: EMPTY_POOL_COOLDOWN_STATE,
      nowMs,
      preferredInstanceId: ProviderInstanceId.make("codex_1"),
    });
    expect(selected?.instanceId).toBe(ProviderInstanceId.make("codex_1"));
    expect(selected?.switched).toBe(false);
  });

  it("switches away from sticky member when cooling down", () => {
    const providers = [
      makeProvider("codex_1", { usedPercent: 10 }),
      makeProvider("codex_2", { usedPercent: 50 }),
    ];
    const cooldownState = recordMemberCooldown(EMPTY_POOL_COOLDOWN_STATE, {
      instanceId: ProviderInstanceId.make("codex_1"),
      untilMs: nowMs + 60_000,
      reason: "usage_limit",
      updatedAtMs: nowMs,
    });
    const selected = selectPoolMember({
      poolId: POOL_ID,
      pool: makePool({
        memberInstanceIds: [ProviderInstanceId.make("codex_1"), ProviderInstanceId.make("codex_2")],
      }),
      providers,
      cooldownState,
      nowMs,
      preferredInstanceId: ProviderInstanceId.make("codex_1"),
    });
    expect(selected?.instanceId).toBe(ProviderInstanceId.make("codex_2"));
    expect(selected?.switched).toBe(true);
  });

  it("breaks equal quota ties using fewest active leases", () => {
    const providers = [
      makeProvider("codex_1", { usedPercent: 20 }),
      makeProvider("codex_2", { usedPercent: 20 }),
    ];
    const cooldownState = setThreadLease(
      EMPTY_POOL_COOLDOWN_STATE,
      "thread-1",
      ProviderInstanceId.make("codex_1"),
    );
    const selected = selectPoolMember({
      poolId: POOL_ID,
      pool: makePool({
        memberInstanceIds: [ProviderInstanceId.make("codex_1"), ProviderInstanceId.make("codex_2")],
      }),
      providers,
      cooldownState,
      nowMs,
    });
    expect(selected?.instanceId).toBe(ProviderInstanceId.make("codex_2"));
  });

  it("supports earliest_reset and round_robin strategies", () => {
    const providers = [
      makeProvider("codex_1", { usedPercent: 30, resetsAt: "2026-11-23T16:00:00.000Z" }),
      makeProvider("codex_2", { usedPercent: 40, resetsAt: "2026-11-23T13:00:00.000Z" }),
      makeProvider("codex_3", { usedPercent: 20, resetsAt: "2026-11-23T15:00:00.000Z" }),
    ];
    const earliest = selectPoolMember({
      poolId: POOL_ID,
      pool: makePool({ strategy: "earliest_reset" }),
      providers,
      cooldownState: EMPTY_POOL_COOLDOWN_STATE,
      nowMs,
    });
    expect(earliest?.instanceId).toBe(ProviderInstanceId.make("codex_2"));

    const rrState = recordPoolSelection(
      EMPTY_POOL_COOLDOWN_STATE,
      POOL_ID,
      ProviderInstanceId.make("codex_2"),
    );
    const rr = selectPoolMember({
      poolId: POOL_ID,
      pool: makePool({ strategy: "round_robin" }),
      providers,
      cooldownState: rrState,
      nowMs,
    });
    expect(rr?.instanceId).toBe(ProviderInstanceId.make("codex_3"));
  });

  it("collapses pool members to one representative for picker", () => {
    const providers = [
      makeProvider("codex_1", { usedPercent: 80 }),
      makeProvider("codex_2", { usedPercent: 10 }),
      makeProvider("codex_3", { authStatus: "unauthenticated" }),
    ];
    const reps = buildPoolRepresentatives({
      pools: { [POOL_ID]: makePool() },
      providers,
      nowMs,
    });
    const summary = reps.byPoolId.get(POOL_ID);
    expect(summary?.representativeInstanceId).toBe(ProviderInstanceId.make("codex_2"));
    expect(summary?.readyCount).toBe(2);
    expect(summary?.totalCount).toBe(3);
    expect(reps.hiddenMemberIds.has(ProviderInstanceId.make("codex_1"))).toBe(true);
    expect(reps.hiddenMemberIds.has(ProviderInstanceId.make("codex_2"))).toBe(false);
    expect(reps.hiddenMemberIds.has(ProviderInstanceId.make("codex_3"))).toBe(true);
  });

  it("filters pool members by requested model compatibility (PRO vs PLUS)", () => {
    const pro1 = ProviderInstanceId.make("agy_pro_1");
    const pro2 = ProviderInstanceId.make("agy_pro_2");
    const plus = ProviderInstanceId.make("agy_plus");
    const providers = [
      makeProvider("agy_plus", {
        usedPercent: 0,
        models: [
          { slug: "gemini-4-hydrogen" },
          { slug: "gemini-3.8-flash", aliases: ["antigravity-default"] },
        ],
      }),
      makeProvider("agy_pro_1", {
        usedPercent: 60,
        models: [
          { slug: "gemini-4-neon" },
          { slug: "gemini-4-hydrogen" },
          { slug: "gemini-3.8-flash", aliases: ["antigravity-default"] },
        ],
      }),
      makeProvider("agy_pro_2", {
        usedPercent: 25,
        models: [
          { slug: "gemini-4-neon" },
          { slug: "gemini-4-hydrogen" },
          { slug: "gemini-3.8-flash", aliases: ["antigravity-default"] },
        ],
      }),
    ];
    const pool = makePool({ memberInstanceIds: [plus, pro1, pro2] });

    // For gemini-4-neon, skip the 0%-used PLUS account and pick the least-used PRO account.
    const neonPick = selectPoolMember({
      poolId: POOL_ID,
      pool,
      providers,
      cooldownState: EMPTY_POOL_COOLDOWN_STATE,
      nowMs,
      model: "gemini-4-neon",
    });
    expect(neonPick?.instanceId).toBe(pro2);

    // Switching mid-thread from a sticky PLUS account to a PRO-only model switches away from PLUS.
    const stickyUpgrade = selectPoolMember({
      poolId: POOL_ID,
      pool,
      providers,
      cooldownState: EMPTY_POOL_COOLDOWN_STATE,
      nowMs,
      model: "gemini-4-neon",
      preferredInstanceId: plus,
      respectSticky: true,
    });
    expect(stickyUpgrade?.instanceId).toBe(pro2);
    expect(stickyUpgrade?.switched).toBe(true);

    // Shared models (and aliases) can still use the 0%-used PLUS account.
    const flashPick = selectPoolMember({
      poolId: POOL_ID,
      pool,
      providers,
      cooldownState: EMPTY_POOL_COOLDOWN_STATE,
      nowMs,
      model: "antigravity-default",
    });
    expect(flashPick?.instanceId).toBe(plus);

    // If all PRO accounts are cooling down, return null instead of falling back to PLUS.
    let allProCooling = recordMemberCooldown(EMPTY_POOL_COOLDOWN_STATE, {
      instanceId: pro1,
      untilMs: nowMs + 60_000,
      reason: "usage_limit",
      updatedAtMs: nowMs,
    });
    allProCooling = recordMemberCooldown(allProCooling, {
      instanceId: pro2,
      untilMs: nowMs + 60_000,
      reason: "usage_limit",
      updatedAtMs: nowMs,
    });
    const noneCompatible = selectPoolMember({
      poolId: POOL_ID,
      pool,
      providers,
      cooldownState: allProCooling,
      nowMs,
      model: "gemini-4-neon",
    });
    expect(noneCompatible).toBeNull();
  });
});
