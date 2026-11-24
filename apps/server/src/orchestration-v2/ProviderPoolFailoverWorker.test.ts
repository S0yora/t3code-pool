import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderPoolId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderPoolService from "../provider/ProviderPoolService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderPoolFailoverWorker from "./ProviderPoolFailoverWorker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

describe("ProviderPoolFailoverWorker", () => {
  it.effect("dispatches manualContinuationOfRunId onto the next pool member on usage_limit", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const dispatched = yield* Queue.unbounded<OrchestrationV2Command>();
      const recordedLimits = yield* Queue.unbounded<{
        readonly instanceId: ProviderInstanceId;
        readonly resetAt?: string | null | undefined;
        readonly reason?: string | undefined;
      }>();

      const acc1 = ProviderInstanceId.make("antigravity");
      const acc2 = ProviderInstanceId.make("duffyfly68");
      const poolId = ProviderPoolId.make("antigravity-pool");
      const threadId = ThreadId.make("thread:failover-test");
      const runId = RunId.make("run:failover-test:1");
      const resetAt = "2026-11-24T19:40:10.000Z";

      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerPools: {
          [poolId]: {
            driver: ProviderDriverKind.make("antigravity"),
            displayName: "Antigravity Pool",
            memberInstanceIds: [acc1, acc2],
            strategy: "least_used" as const,
            autoFailover: true,
            stickyThread: true,
            enabled: true,
          },
        },
      };

      const layer = ProviderPoolFailoverWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  id: threadId,
                  status: "failed",
                  lastErrorClass: "usage_limit",
                  usageLimitResetAt: resetAt,
                  latestRunId: runId,
                  archivedAt: null,
                  pendingRuntimeRequest: null,
                } as never),
              dispatch: (command) => Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(settings),
            }),
            Layer.mock(ProviderPoolService.ProviderPoolService)({
              releaseThread: () => Effect.void,
              recordUsageLimit: (input) => Queue.offer(recordedLimits, input).pipe(Effect.asVoid),
              resolveModelSelection: (input) =>
                Effect.succeed({
                  modelSelection: { ...input.modelSelection, instanceId: acc2 },
                  poolId,
                  switched: true,
                }),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        yield* Queue.offer(events, {
          type: "run.updated",
          payload: {
            id: runId,
            threadId,
            status: "failed",
            modelSelection: { instanceId: acc1, model: "gemini-4-neon" },
          },
        } as never);

        const limit = yield* Queue.take(recordedLimits);
        assert.deepEqual(limit, {
          instanceId: acc1,
          resetAt,
          reason: "usage_limit",
        });

        const command = yield* Queue.take(dispatched);
        assert.equal(command.type, "message.dispatch");
        if (command.type === "message.dispatch") {
          assert.equal(command.threadId, threadId);
          assert.equal(command.modelSelection?.instanceId, acc2);
          assert.equal(command.manualContinuationOfRunId, runId);
          assert.isUndefined(command.usageLimitContinuationOfRunId);
          assert.equal(command.text, "");
          assert.deepEqual(command.dispatchMode, { type: "start_immediately" });
        }
      }).pipe(Effect.provide(layer));
    }),
  );
});
