import type {
  ProviderInstanceId,
  ProviderPoolConfig,
  ProviderPoolId,
  ServerProvider,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, LayersIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Badge } from "../ui/badge";

interface SidebarRowLike {
  readonly instanceId: ProviderInstanceId;
}

export function ProviderPoolSidebarGroups<TRow extends SidebarRowLike>({
  rows,
  providerPools,
  serverProviders,
  selectedInstanceId,
  renderRow,
}: {
  readonly rows: ReadonlyArray<TRow>;
  readonly providerPools: Readonly<Record<ProviderPoolId, ProviderPoolConfig>> | undefined;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly selectedInstanceId: ProviderInstanceId | null;
  readonly renderRow: (row: TRow) => ReactNode;
}) {
  const gt = useGT();
  const [collapsedPools, setCollapsedPools] = useState<ReadonlySet<ProviderPoolId>>(
    () => new Set(),
  );

  const poolEntries = Object.entries(providerPools ?? {}) as Array<
    [ProviderPoolId, ProviderPoolConfig]
  >;

  if (poolEntries.length === 0) {
    return <>{rows.map((row) => renderRow(row))}</>;
  }

  const rowById = new Map(rows.map((row) => [row.instanceId, row] as const));
  const providerById = new Map(
    serverProviders.map((provider) => [provider.instanceId, provider] as const),
  );
  const claimedIds = new Set<ProviderInstanceId>();

  const groups: Array<{
    readonly poolId: ProviderPoolId;
    readonly pool: ProviderPoolConfig;
    readonly memberRows: ReadonlyArray<TRow>;
    readonly readyCount: number;
  }> = [];

  for (const [poolId, pool] of poolEntries) {
    const memberRows: TRow[] = [];
    for (const memberId of pool.memberInstanceIds) {
      if (claimedIds.has(memberId)) continue;
      const row = rowById.get(memberId);
      if (!row) continue;
      claimedIds.add(memberId);
      memberRows.push(row);
    }
    if (memberRows.length === 0) continue;

    const readyCount = memberRows.filter((row) => {
      const live = providerById.get(row.instanceId);
      return (
        live !== undefined &&
        live.enabled &&
        live.installed &&
        live.auth.status !== "unauthenticated" &&
        live.availability !== "unavailable"
      );
    }).length;

    groups.push({ poolId, pool, memberRows, readyCount });
  }

  if (groups.length === 0) {
    return <>{rows.map((row) => renderRow(row))}</>;
  }

  const unpooledRows = rows.filter((row) => !claimedIds.has(row.instanceId));

  const togglePool = (poolId: ProviderPoolId) => {
    setCollapsedPools((previous) => {
      const next = new Set(previous);
      if (next.has(poolId)) {
        next.delete(poolId);
      } else {
        next.add(poolId);
      }
      return next;
    });
  };

  return (
    <>
      {groups.map(({ poolId, pool, memberRows, readyCount }) => {
        const hasSelected =
          selectedInstanceId !== null &&
          memberRows.some((row) => row.instanceId === selectedInstanceId);
        const isCollapsed = collapsedPools.has(poolId);
        const Chevron = isCollapsed ? ChevronRightIcon : ChevronDownIcon;

        return (
          <div key={poolId} className="bg-muted/15">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() => togglePool(poolId)}
              className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left transition-colors outline-none hover:bg-muted/30 focus-visible:bg-muted/30 sm:px-3.5"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <LayersIcon
                  className={
                    hasSelected
                      ? "size-3.5 shrink-0 text-foreground"
                      : "size-3.5 shrink-0 text-muted-foreground"
                  }
                  aria-hidden
                />
                <span className="truncate text-xs font-medium text-foreground">
                  {pool.displayName}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {!pool.enabled ? (
                  <Badge variant="outline" size="sm">
                    {gt("Off")}
                  </Badge>
                ) : null}
                <Badge variant={readyCount > 0 && pool.enabled ? "secondary" : "outline"} size="sm">
                  {readyCount}/{memberRows.length}
                </Badge>
              </span>
            </button>

            {!isCollapsed ? (
              <div className="ms-3 divide-y divide-border/40 border-t border-l border-border/60 bg-background/40">
                {memberRows.map((row) => renderRow(row))}
              </div>
            ) : null}
          </div>
        );
      })}

      {unpooledRows.length > 0 ? (
        <>
          <div className="bg-muted/20 px-3 py-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase sm:px-4">
            {gt("Unpooled")}
          </div>
          {unpooledRows.map((row) => renderRow(row))}
        </>
      ) : null}
    </>
  );
}
