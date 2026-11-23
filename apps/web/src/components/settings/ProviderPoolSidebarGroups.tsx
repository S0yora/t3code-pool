import type {
  ProviderInstanceId,
  ProviderPoolConfig,
  ProviderPoolId,
  ServerProvider,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

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
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(() => new Set());

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

  const setGroupOpen = (key: string, open: boolean) => {
    setClosedGroups((previous) => {
      const next = new Set(previous);
      if (open) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <>
      {groups.map(({ poolId, pool, memberRows, readyCount }) => {
        const key = `pool:${poolId}`;
        const hasSelected =
          selectedInstanceId !== null &&
          memberRows.some((row) => row.instanceId === selectedInstanceId);
        const open = !closedGroups.has(key);

        return (
          <Collapsible
            key={poolId}
            open={open}
            onOpenChange={(nextOpen) => setGroupOpen(key, nextOpen)}
          >
            <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-2 px-3 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
              />
              <ProviderInstanceIcon
                driverKind={pool.driver}
                displayName={pool.displayName}
                size="compact"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  hasSelected || pool.enabled ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {pool.displayName}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {!pool.enabled ? `${gt("Off")} · ` : ""}
                {readyCount}/{memberRows.length}
              </span>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="divide-y divide-border/50 border-t border-border/50 bg-background/35 ps-3">
                {memberRows.map((row) => renderRow(row))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        );
      })}

      {unpooledRows.length > 0 ? (
        <Collapsible
          open={!closedGroups.has("unpooled")}
          onOpenChange={(nextOpen) => setGroupOpen("unpooled", nextOpen)}
        >
          <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-2 px-3 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
            />
            <span className="min-w-0 flex-1 truncate">{gt("Unpooled")}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {unpooledRows.length}
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="divide-y divide-border/50 border-t border-border/50">
              {unpooledRows.map((row) => renderRow(row))}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </>
  );
}
