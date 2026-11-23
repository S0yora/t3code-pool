import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderPoolId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { isProviderInstancePickerVisible, providerInstanceEntriesFor } from "./providerInstances";

function makeProvider(
  id: string,
  driver: string,
  status: ServerProvider["status"] = "ready",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: id,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "gemini-4-neon",
        name: "Gemini 4 Neon",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
  };
}

describe("providerInstances pool collapse", () => {
  it("collapses enabled pool members into one visible picker entry with ready count", () => {
    const acc1 = ProviderInstanceId.make("antigravity_1");
    const acc2 = ProviderInstanceId.make("antigravity_2");
    const acc3 = ProviderInstanceId.make("antigravity_3");
    const codex = ProviderInstanceId.make("codex");
    const agyDriver = ProviderDriverKind.make("antigravity");

    const providers = [
      makeProvider("antigravity_1", "antigravity", "error"),
      makeProvider("antigravity_2", "antigravity", "ready"),
      makeProvider("antigravity_3", "antigravity", "ready"),
      makeProvider("codex", "codex", "ready"),
    ];

    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [acc1]: { driver: agyDriver, enabled: true },
        [acc2]: { driver: agyDriver, enabled: true },
        [acc3]: { driver: agyDriver, enabled: true },
      },
      providerPools: {
        [ProviderPoolId.make("agy-pool")]: {
          driver: agyDriver,
          displayName: "Antigravity Pool",
          memberInstanceIds: [acc1, acc2, acc3],
          strategy: "least_used",
          autoFailover: true,
          stickyThread: true,
          enabled: true,
        },
      },
    };

    const entries = providerInstanceEntriesFor(providers, settings, null);
    const visible = entries.filter(isProviderInstancePickerVisible);

    expect(visible.map((e) => e.instanceId)).toEqual([acc2, codex]);
    const poolRep = visible.find((e) => e.instanceId === acc2);
    expect(poolRep?.displayName).toBe("Antigravity Pool");
    expect(poolRep?.poolMemberCount).toBe(3);
    expect(poolRep?.poolReadyCount).toBe(2);
    expect(poolRep?.hiddenInPool).toBe(false);

    const hiddenMember = entries.find((e) => e.instanceId === acc3);
    expect(hiddenMember?.hiddenInPool).toBe(true);
    expect(hiddenMember?.poolRepresentativeId).toBe(acc2);
  });

  it("keeps all members visible when pool is disabled", () => {
    const acc1 = ProviderInstanceId.make("antigravity_1");
    const acc2 = ProviderInstanceId.make("antigravity_2");
    const agyDriver = ProviderDriverKind.make("antigravity");
    const providers = [
      makeProvider("antigravity_1", "antigravity", "ready"),
      makeProvider("antigravity_2", "antigravity", "ready"),
    ];
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [acc1]: { driver: agyDriver, enabled: true },
        [acc2]: { driver: agyDriver, enabled: true },
      },
      providerPools: {
        [ProviderPoolId.make("agy-pool")]: {
          driver: agyDriver,
          displayName: "Antigravity Pool",
          memberInstanceIds: [acc1, acc2],
          strategy: "least_used",
          autoFailover: true,
          stickyThread: true,
          enabled: false,
        },
      },
    };

    const entries = providerInstanceEntriesFor(providers, settings, null);
    const visible = entries.filter(isProviderInstancePickerVisible);
    expect(visible.map((e) => e.instanceId)).toEqual([acc1, acc2]);
  });
});
