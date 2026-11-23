import { CommandId, MessageId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { findPoolForInstance } from "@t3tools/shared/accountPool";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ProviderPoolService from "../provider/ProviderPoolService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const FAILOVER_WINDOW_MS = 10 * 60_000;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const poolServiceOption = yield* Effect.serviceOption(ProviderPoolService.ProviderPoolService);
    if (Option.isNone(poolServiceOption)) return;
    const poolService = poolServiceOption.value;

    const failoverHistoryRef = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(
      new Map(),
    );

    const handleEvent = Effect.fn("ProviderPoolFailoverWorker.handleEvent")(function* (
      event: OrchestrationV2DomainEvent,
    ) {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      if (run.status === "completed" || run.status === "cancelled" || run.status === "failed") {
        yield* poolService.releaseThread(run.threadId);
      }
      if (run.status !== "failed") return;

      const shell = yield* threads.getThreadShell(run.threadId).pipe(Effect.option);
      if (Option.isNone(shell) || shell.value === null) return;
      const thread = shell.value;
      if (
        thread.status !== "failed" ||
        thread.lastErrorClass !== "usage_limit" ||
        thread.latestRunId !== run.id ||
        thread.archivedAt !== null ||
        thread.pendingRuntimeRequest !== null
      ) {
        return;
      }

      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      if (Option.isNone(settings)) return;

      const failedInstanceId = run.modelSelection.instanceId;
      const poolMatch = findPoolForInstance(settings.value.providerPools, failedInstanceId);
      if (poolMatch === null || !poolMatch.pool.autoFailover) return;

      yield* poolService.recordUsageLimit({
        instanceId: failedInstanceId,
        resetAt: thread.usageLimitResetAt,
        reason: "usage_limit",
      });

      const nowMs = yield* Clock.currentTimeMillis;
      const maxAttempts = Math.max(poolMatch.pool.memberInstanceIds.length, 2);
      const allowed = yield* Ref.modify(failoverHistoryRef, (current) => {
        const recent = (current.get(run.threadId) ?? []).filter(
          (ts) => nowMs - ts < FAILOVER_WINDOW_MS,
        );
        if (recent.length >= maxAttempts) {
          return [false, current] as const;
        }
        const next = new Map(current);
        next.set(run.threadId, [...recent, nowMs]);
        return [true, next] as const;
      });
      if (!allowed) return;

      const resolved = yield* poolService.resolveModelSelection({
        modelSelection: run.modelSelection,
        threadId: run.threadId,
        excludeInstanceIds: new Set([failedInstanceId]),
        respectSticky: false,
      });

      if (!resolved.switched || resolved.modelSelection.instanceId === failedInstanceId) {
        return;
      }

      const identity = `${run.threadId}:${run.id}:${resolved.modelSelection.instanceId}`;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`pool-failover:${identity}`),
          messageId: MessageId.make(`pool-failover:${identity}`),
          threadId: run.threadId,
          modelSelection: resolved.modelSelection,
          usageLimitContinuationOfRunId: run.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.tap(() =>
            Effect.logInfo("account-pool.failover.dispatched", {
              threadId: run.threadId,
              poolId: poolMatch.poolId,
              fromInstanceId: failedInstanceId,
              toInstanceId: resolved.modelSelection.instanceId,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("account-pool.failover.dispatch-failed", {
              threadId: run.threadId,
              poolId: poolMatch.poolId,
              cause,
            }),
          ),
        );
    });

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        handleEvent(event).pipe(Effect.ignoreCause({ log: true })),
      ),
    );
  }),
);
