import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  ProviderPoolEncryptedBundle,
  ProviderPoolHubReportPayload,
  settingsSecretLiteral,
} from "@t3tools/contracts";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PoolDirectSnapshotSchema, ProviderPoolService } from "./ProviderPoolService.ts";

const utf8Encoder = new TextEncoder();

function constantTimeTokenEquals(actual: string, expected: string): boolean {
  const left = utf8Encoder.encode(actual);
  const right = utf8Encoder.encode(expected);
  if (left.byteLength === 0 || left.byteLength !== right.byteLength) {
    return false;
  }
  return Mac.timingSafeEqual(left, right);
}

const authorizeHubRequest = Effect.fn("PoolHubRoute.authorizeHubRequest")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((svc) => svc.getSettings),
    Effect.orDie,
  );
  const sync = settings.providerPoolSync;
  if (!sync.enabled || sync.mode !== "hub") {
    return {
      ok: false as const,
      response: HttpServerResponse.jsonUnsafe(
        { error: "Pool hub mode is not enabled on this server." },
        { status: 404 },
      ),
    };
  }
  const expectedToken = settingsSecretLiteral(sync.syncToken).trim();
  if (!expectedToken) {
    return {
      ok: false as const,
      response: HttpServerResponse.jsonUnsafe(
        { error: "Pool hub sync token is not configured." },
        { status: 503 },
      ),
    };
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  const authHeader = request.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!constantTimeTokenEquals(token, expectedToken)) {
    return {
      ok: false as const,
      response: HttpServerResponse.jsonUnsafe({ error: "Unauthorized." }, { status: 401 }),
    };
  }
  return { ok: true as const };
});

const SyncActionInput = Schema.Struct({
  action: Schema.Literals(["sync", "push", "pull"]),
});

export const layer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/pool-hub/status",
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const sessionResult = yield* environmentAuth
        .authenticateHttpRequest(request)
        .pipe(Effect.option);
      if (sessionResult._tag === "None") {
        return HttpServerResponse.jsonUnsafe({ error: "Unauthorized." }, { status: 401 });
      }
      if (!sessionResult.value.scopes.includes(AuthOrchestrationReadScope)) {
        return HttpServerResponse.jsonUnsafe({ error: "Forbidden." }, { status: 403 });
      }
      const poolService = yield* ProviderPoolService;
      const state = yield* poolService.getHubState;
      return HttpServerResponse.jsonUnsafe(state, { status: 200 });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/api/pool-hub/state",
    Effect.gen(function* () {
      const auth = yield* authorizeHubRequest();
      if (!auth.ok) return auth.response;
      const poolService = yield* ProviderPoolService;
      const state = yield* poolService.getHubState;
      return HttpServerResponse.jsonUnsafe(state, { status: 200 });
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/pool-hub/report",
    Effect.gen(function* () {
      const auth = yield* authorizeHubRequest();
      if (!auth.ok) return auth.response;
      const parsed = yield* HttpServerRequest.schemaBodyJson(ProviderPoolHubReportPayload).pipe(
        Effect.option,
      );
      if (parsed._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { error: "Invalid pool hub report payload." },
          { status: 400 },
        );
      }
      const poolService = yield* ProviderPoolService;
      const state = yield* poolService.ingestHubReport(parsed.value);
      return HttpServerResponse.jsonUnsafe(state, { status: 200 });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/api/pool-hub/bundle",
    Effect.gen(function* () {
      const auth = yield* authorizeHubRequest();
      if (!auth.ok) return auth.response;
      const poolService = yield* ProviderPoolService;
      const bundle = yield* poolService.getEncryptedBundle;
      if (!bundle) {
        return HttpServerResponse.jsonUnsafe({ error: "No bundle stored yet." }, { status: 404 });
      }
      return HttpServerResponse.jsonUnsafe(bundle, { status: 200 });
    }),
  ),
  HttpRouter.add(
    "PUT",
    "/api/pool-hub/bundle",
    Effect.gen(function* () {
      const auth = yield* authorizeHubRequest();
      if (!auth.ok) return auth.response;
      const parsed = yield* HttpServerRequest.schemaBodyJson(ProviderPoolEncryptedBundle).pipe(
        Effect.option,
      );
      if (parsed._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { error: "Invalid encrypted pool bundle payload." },
          { status: 400 },
        );
      }
      const poolService = yield* ProviderPoolService;
      const result = yield* poolService.putEncryptedBundle(parsed.value);
      return HttpServerResponse.jsonUnsafe(result, { status: 200 });
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/pool-hub/sync",
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const sessionResult = yield* environmentAuth
        .authenticateHttpRequest(request)
        .pipe(Effect.option);
      if (sessionResult._tag === "None") {
        return HttpServerResponse.jsonUnsafe({ error: "Unauthorized." }, { status: 401 });
      }
      if (!sessionResult.value.scopes.includes(AuthProvidersManageScope)) {
        return HttpServerResponse.jsonUnsafe({ error: "Forbidden." }, { status: 403 });
      }

      const body = yield* HttpServerRequest.schemaBodyJson(SyncActionInput).pipe(Effect.option);
      if (body._tag === "None") {
        return HttpServerResponse.jsonUnsafe({ error: "Invalid sync action." }, { status: 400 });
      }
      const poolService = yield* ProviderPoolService;
      const result =
        body.value.action === "push"
          ? yield* poolService.pushEncryptedBundle
          : body.value.action === "pull"
            ? yield* poolService.pullEncryptedBundle
            : yield* poolService.syncNow;
      return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 400 });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/api/pool-hub/snapshot-meta",
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const sessionResult = yield* environmentAuth
        .authenticateHttpRequest(request)
        .pipe(Effect.option);
      if (sessionResult._tag === "None") {
        return HttpServerResponse.jsonUnsafe({ error: "Unauthorized." }, { status: 401 });
      }
      if (!sessionResult.value.scopes.includes(AuthProvidersManageScope)) {
        return HttpServerResponse.jsonUnsafe({ error: "Forbidden." }, { status: 403 });
      }
      const poolService = yield* ProviderPoolService;
      const meta = yield* poolService.getDirectSnapshotMeta;
      return HttpServerResponse.jsonUnsafe(meta, { status: 200 });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/api/pool-hub/snapshot",
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const sessionResult = yield* environmentAuth
        .authenticateHttpRequest(request)
        .pipe(Effect.option);
      if (sessionResult._tag === "None") {
        return HttpServerResponse.jsonUnsafe({ error: "Unauthorized." }, { status: 401 });
      }
      if (!sessionResult.value.scopes.includes(AuthProvidersManageScope)) {
        return HttpServerResponse.jsonUnsafe({ error: "Forbidden." }, { status: 403 });
      }
      const poolService = yield* ProviderPoolService;
      const snapshot = yield* poolService.exportDirectSnapshot;
      return HttpServerResponse.jsonUnsafe(snapshot, { status: 200 });
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/pool-hub/snapshot",
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const sessionResult = yield* environmentAuth
        .authenticateHttpRequest(request)
        .pipe(Effect.option);
      if (sessionResult._tag === "None") {
        return HttpServerResponse.jsonUnsafe({ error: "Unauthorized." }, { status: 401 });
      }
      if (!sessionResult.value.scopes.includes(AuthProvidersManageScope)) {
        return HttpServerResponse.jsonUnsafe({ error: "Forbidden." }, { status: 403 });
      }
      const parsed = yield* HttpServerRequest.schemaBodyJson(PoolDirectSnapshotSchema).pipe(
        Effect.option,
      );
      if (parsed._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { error: "Invalid direct pool snapshot payload." },
          { status: 400 },
        );
      }
      const poolService = yield* ProviderPoolService;
      const result = yield* poolService.importDirectSnapshot(parsed.value);
      return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 400 });
    }),
  ),
);
