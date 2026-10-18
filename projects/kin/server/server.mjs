import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { PairingError, PairingService, parseHouseholdPolicy, requireTrustAuthority } from "./pairing-service.mjs";
import { deviceLabel } from "./pairing-service/device-label.mjs";
import { configuredDatabasePath, permissionProblem } from "./permissions.mjs";
import { builtInManifest, etagMatches, INSTALL_ICONS, publishedManifest } from "./install-identity.mjs";
import { PushService } from "./push-service.mjs";
import { ChatBlobService } from "./chat-blob-service.mjs";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { EncryptedSyncService, MAX_EVENTS_PER_BATCH } from "./sync-service.mjs";
import { isEventEnvelopeValid, isSyncId } from "./sync-contract.mjs";
import {
  DurableConflictError,
  DurableStore,
  DurableStoreError,
  MAX_ATTACHMENT_BYTES,
} from "./durable-store.mjs";
import { WebAuthn } from "./webauthn.mjs";
import { readBody, readJsonBody } from "./http-body.mjs";
import {
  decodeEnvelopeBatch,
  encodeEventPage,
  ENVELOPE_CONTENT_TYPE,
  EnvelopeWireError,
  MAX_CIPHERTEXT_BYTES,
  RECORD_FIXED,
} from "../web/sync/envelope-wire.js";
import { isInsideRoot, webRoot } from "./path-safety.mjs";
import { clientKey, parseTrustedProxies } from "./client-key.mjs";
import { LiveService } from "./live/live-service.mjs";

const FLOW_TTL_MS = 2 * 60_000;
const MAX_ACTIVE_FLOWS = 512;

export function createKinServer(options = {}) {
  const port = options.port ?? Number(process.env.KIN_PORT ?? 8000);
  const host = options.host ?? process.env.KIN_HOST ?? "127.0.0.1";
  const origin =
    options.origin ?? process.env.KIN_ORIGIN ?? `http://localhost:${port}`;
  assertSecureOrigin(host, origin);
  const trustedProxies =
    options.trustedProxies instanceof Set
      ? options.trustedProxies
      : parseTrustedProxies(options.trustedProxies ?? process.env.KIN_TRUSTED_PROXIES);
  const householdSettings = {
    allowNewHouseholds: options.allowNewHouseholds ?? process.env.KIN_ALLOW_NEW_HOUSEHOLDS,
    maxHouseholds: options.maxHouseholds ?? process.env.KIN_MAX_HOUSEHOLDS,
  };
  const householdPolicy = parseHouseholdPolicy(householdSettings);
  // A passed-in service keeps its own policy unless a setting is given here.
  const householdPolicyConfigured = [householdSettings.allowNewHouseholds, householdSettings.maxHouseholds]
    .some((value) => value !== undefined && value !== null && value !== "");
  const databasePath = configuredDatabasePath({ databasePath: options.databasePath, dataDirectory: options.dataDirectory });
  const store =
    options.store === false
      ? null
      : (options.store ??
        new DurableStore(databasePath, {
          acquireProcessLock: options.acquireProcessLock,
        }));
  if (options.store) store.validate();
  const service =
    options.service ?? new PairingService({ now: options.now, store, householdPolicy });
  if (householdPolicyConfigured) service.householdPolicy = householdPolicy;
  if (options.service && store && !service.store) {
    service.store = store;
    for (const householdId of service.households.keys())
      store.saveIdentityHousehold(householdId, service);
  }
  const syncService =
    options.syncService ??
    new EncryptedSyncService(service, { now: options.now, store });
  if (options.syncService && store && !syncService.store) {
    syncService.store = store;
    for (const [householdId, state] of syncService.households)
      store.saveSyncState(householdId, state, service);
  }
  // Push notifications (#85). Subscriptions belong to this service's store.
  // VAPID's subject must be a mailto: or https: URL the push services accept;
  // the deployment's own origin is one unless KIN_PUSH_SUBJECT says otherwise.
  const pushService = options.pushService ?? new PushService({ pairingService: service, store, now: options.now ?? (() => Date.now()),
    subject: process.env.KIN_PUSH_SUBJECT || origin });
  syncService.pushService = pushService;
  // Chat content blobs (#110).
  const chatBlobService = new ChatBlobService({ pairingService: service, store, now: options.now ?? (() => Date.now()) });
  syncService.chatBlobService = chatBlobService;
  // The chat relay (#111): chat events in their own encrypted stream.
  const chatRelayService = new ChatRelayService({ syncService, store });
  syncService.chatRelayService = chatRelayService;
  const webauthn =
    options.webauthn ??
    new WebAuthn({
      rpId: new URL(origin).hostname,
      origin,
      now: options.now,
      maxChallenges: options.maxChallenges,
      maxAnonymousChallenges: options.maxAnonymousChallenges,
    });
  const maxFlows = options.maxFlows ?? MAX_ACTIVE_FLOWS;
  const context = {
    service,
    syncService,
    pushService,
    chatBlobService,
    chatRelayService,
    store,
    webauthn,
    flows: new Map(),
    now: options.now ?? (() => Date.now()),
    maxFlows,
    maxAnonymousFlows: Math.max(
      0,
      Math.min(
        maxFlows,
        options.maxAnonymousFlows ?? defaultAnonymousCapacity(maxFlows),
      ),
    ),
    secureCookies: new URL(origin).protocol === "https:",
    origin,
    clientKey: (request) => clientKey(request, trustedProxies),
  };
  // The live channel (#107): one WebSocket per trusted device at /api/live.
  const liveService = options.liveService ?? new LiveService({
    service, origin, store, readSession: (request) => cookies(request).kin_session, ...(options.live ?? {}),
  });
  syncService.liveService = liveService;
  context.liveService = liveService;
  const server = createServer(async (request, response) => {
    const requestId = randomBytes(12).toString("hex");
    response.setHeader("X-Request-ID", requestId);
    try {
      setHeaders(response);
      const url = new URL(request.url, origin);
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readiness") {
        try {
          store?.health();
          json(response, 200, { ready: true });
        } catch {
          json(response, 503, { ready: false });
        }
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (request.headers.origin && request.headers.origin !== origin)
          throw new PairingError(
            "origin_rejected",
            "The request origin was rejected.",
            403,
          );
        store?.assertAvailable();
        await api(request, response, url, context);
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        if (url.pathname === "/manifest.webmanifest") {
          serveManifest(request, response, context);
          return;
        }
        const icon = INSTALL_ICON_ROUTE.exec({ pathname: url.pathname });
        if (icon) {
          serveInstallIcon(request, response, url, icon.pathname.groups.file, context);
          return;
        }
      }
      serve(response, url.pathname);
    } catch (error) {
      if (request.kinPasskeyFlow)
        context.webauthn.discardFlow?.(request.kinPasskeyFlow);
      if (
        error instanceof PairingError &&
        [
          "authentication_required",
          "device_not_trusted",
          "membership_removed",
          "household_deletion_pending",
          "household_deleted",
        ].includes(error.code)
      ) {
        clearCookie(response, "kin_session", context.secureCookies);
        if (
          ![
            "authentication_required",
            "household_deletion_pending",
          ].includes(error.code)
        )
          clearCookie(response, "kin_device", context.secureCookies);
      }
      const safe =
        error instanceof PairingError
          ? error
          : error instanceof DurableConflictError && !store?.failed
            ? new PairingError(error.code, error.message, 409)
            : error instanceof DurableStoreError || store?.failed
              ? new PairingError(
                  "durable_store_unavailable",
                  "Kin's durable service is unavailable. Restart the service before retrying.",
                  503,
                )
              : new PairingError(
                  "server_error",
                  "Kin could not complete that request.",
                  500,
                );
      console.error(
        JSON.stringify({
          event: "request_failed",
          requestId,
          outcome: safe.code,
        }),
      );
      json(response, safe.status, { error: safe.code, message: safe.message });
    }
  });
  const pruneExpiredDeletions = () => {
    try {
      for (const householdId of service.finalizeExpiredDeletions(context.now()))
        syncService.forgetHousehold(householdId);
    } catch {
      console.error(
        JSON.stringify({
          event: "household_deletion_finalize_failed",
          outcome: "durable_store_unavailable",
        }),
      );
    }
  };
  const lifecycleTimer = setInterval(pruneExpiredDeletions, 60_000);
  lifecycleTimer.unref?.();
  server.on("close", () => clearInterval(lifecycleTimer));
  server.on("upgrade", (request, socket, head) => {
    try {
      liveService.handleUpgrade(request, socket, head);
    } catch {
      socket.destroy();
    }
  });
  // close() waits for open sockets, so end live connections first.
  const close = server.close.bind(server);
  server.close = (callback) => {
    liveService.closeAll();
    return close(callback);
  };
  return {
    server,
    service,
    syncService,
    pushService,
    chatBlobService,
    chatRelayService,
    liveService,
    webauthn,
    store,
    flows: context.flows,
    origin,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  let application;
  try {
    // The sandbox (#106): refuse to serve without it, except for explicit
    // local development (`npm run dev`), which Node's --watch needs.
    const unrestricted = process.argv.includes("--unrestricted");
    const problem = permissionProblem(configuredDatabasePath());
    if (problem && !unrestricted) {
      const error = new Error(problem);
      error.code = "permission_model_required";
      throw error;
    }
    if (unrestricted && process.permission)
      throw Object.assign(new Error("--unrestricted cannot be combined with Node's permission model."), { code: "permission_model_required" });
    if (unrestricted)
      console.warn(JSON.stringify({ event: "permission_model_disabled", message: "Running without Node's permission model. Use this only for local development." }));
    const port = Number(process.env.KIN_PORT ?? 8000);
    const host = process.env.KIN_HOST ?? "127.0.0.1";
    const origin = process.env.KIN_ORIGIN ?? `http://localhost:${port}`;
    application = createKinServer({
      port,
      host,
      origin,
      acquireProcessLock: true,
    });
    application.server.on("error", (error) => {
      const code =
        typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
          ? error.code
          : "UNKNOWN";
      const guidance = {
        EADDRINUSE:
          "Another process is already listening on this address. Stop that process or choose a different KIN_PORT, then retry.",
        EACCES:
          "The operating system denied access to this address or port. Check port reservations and permissions, or choose a different KIN_PORT, then retry.",
        EADDRNOTAVAIL:
          "The configured KIN_HOST is unavailable on this computer. Choose an available loopback address and retry.",
      };
      console.error(
        JSON.stringify({
          event: "startup_failed",
          outcome: "listen_failed",
          code,
          host,
          port,
          message:
            guidance[code] ??
            "Kin could not listen on the configured address. Check KIN_HOST and KIN_PORT, then retry.",
        }),
      );
      application.store?.close();
      process.exitCode = 1;
    });
    application.server.listen(port, host, () => {
      console.log(JSON.stringify({ event: "service_ready", origin }));
    });
    installShutdown(application);
  } catch (error) {
    application?.store?.close();
    console.error(
      JSON.stringify({
        event: "startup_failed",
        outcome:
          error.code === "durable_lock_exists" || error.code === "permission_model_required"
            ? error.code
            : "configuration_or_storage",
        ...(["durable_lock_exists", "trusted_proxies_invalid", "household_policy_invalid", "permission_model_required"].includes(error.code) ? { message: error.message } : {}),
        ...(error.code === "ERR_ACCESS_DENIED" || error.cause?.code === "ERR_ACCESS_DENIED" ? { message: "Node's permission model denied access to a path the service needs. Start Kin with server/start.mjs, which allows the app and data directories." } : {}),
      }),
    );
    process.exitCode = 1;
  }
}

function assertSecureOrigin(host, origin) {
  let external;
  try {
    external = new URL(origin);
  } catch {
    throw new Error("Kin requires a valid configured origin.");
  }
  const loopback = (value) =>
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    value === "[::1]" ||
    (isIP(value) === 4 && value.split(".")[0] === "127");
  if (!loopback(host))
    throw new Error(
      "Kin's built-in server must bind to loopback; use a trusted TLS proxy for external access.",
    );
  if (
    !["http:", "https:"].includes(external.protocol) ||
    external.username ||
    external.password ||
    external.search ||
    external.hash ||
    (external.pathname !== "/" && external.pathname !== "")
  )
    throw new Error("Kin requires a valid origin without credentials or a path.");
  if (external.protocol !== "https:" && !loopback(external.hostname)) {
    throw new Error(
      "Kin requires an HTTPS origin outside loopback development.",
    );
  }
}

async function api(request, response, url, context) {
  const { service, syncService, webauthn, secureCookies } = context;
  withTransaction(context, () => {
    for (const expired of service.expireTemporaryMemberships(context.now()))
      syncService.onAccessChange(expired.householdId, expired.deviceIds);
  });
  for (const householdId of service.finalizeExpiredDeletions(context.now()))
    syncService.forgetHousehold(householdId);
  // A chat blob upload is authorized before its body is read, so nobody
  // without a session can make the service buffer 4 MiB.
  const chatBlobRoute = CHAT_BLOB_ROUTE.exec({ pathname: url.pathname })?.pathname.groups.ref ?? null;
  const chatUploadAuth = request.method === "PUT" && chatBlobRoute
    ? syncService.authorize(cookies(request).kin_session)
    : null;
  const binaryUpload = (request.method === "POST" && /^\/api\/sync\/attachments\/[a-f0-9]{32}$/.test(url.pathname)) ||
    chatUploadAuth !== null ||
    (request.method === "PUT" && url.pathname === "/api/household/settings");
  // Event envelopes travel as binary batches (web/sync/envelope-wire.js).
  const envelopePush = request.method === "POST" && (url.pathname === "/api/sync/events" || url.pathname === "/api/chat/events");
  const body = envelopePush
    ? await readEnvelopeBatch(request, response)
    : binaryUpload
    ? await readBinary(request, response)
    : request.method === "PUT" && url.pathname === "/api/household/install-identity"
    ? await readJsonBody(request, response, MAX_INSTALL_IDENTITY_BODY_BYTES)
    : ["POST", "PUT", "DELETE"].includes(request.method)
    ? await readJsonBody(request, response, MAX_JSON_BODY_BYTES)
    : {};
  if (
    request.method === "POST" &&
    url.pathname.endsWith("/finish") &&
    typeof body.flow === "string"
  )
    request.kinPasskeyFlow = body.flow;
  const session = cookies(request).kin_session;
  const claimToken = cookies(request).kin_claim;
  const deviceToken = cookies(request).kin_device;

  if (request.method === "GET" && url.pathname === "/api/household/lifecycle") {
    const householdId = url.searchParams.get("householdId") ?? "";
    if (!/^[a-f0-9]{32}$/.test(householdId)) throw badRequest();
    const knownHousehold = service.households.get(householdId);
    const lifecycle =
      context.store?.lifecycleInfo(householdId) ??
      (knownHousehold
        ? {
            state: knownHousehold.lifecycleState ?? "active",
            finalizeAt: knownHousehold.deletionFinalizeAt ?? null,
          }
        : null);
    if (!lifecycle)
      throw new PairingError(
        "household_not_found",
        "That household is unavailable.",
        404,
      );
    json(response, 200, {
      state: lifecycle.state,
      finalizeAt: lifecycle.finalizeAt,
      message:
        lifecycle.state === "deleted"
          ? "This household was deleted and can no longer sync."
          : lifecycle.state === "deletion_pending"
            ? "This household is pending deletion and can no longer sync."
            : "This household is active.",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    let identity = null;
    let claim = null;
    let householdLifecycle = null;
    try {
      const auth = service.authorize(session);
      identity = {
        householdId: auth.household.id,
        memberId: auth.member.id,
        deviceId: auth.device.id,
      };
    } catch {
      if (session) clearCookie(response, "kin_session", secureCookies);
      if (deviceToken) {
        try {
          const { member, device } = service.trustedDevice(deviceToken, {
            allowDeletionPending: true,
          });
          const household = service.households.get(member.householdId);
          if (household?.lifecycleState === "deletion_pending")
            householdLifecycle = {
              householdId: household.id,
              state: "deletion_pending",
              finalizeAt: household.deletionFinalizeAt,
              message:
                "This household is pending deletion and can no longer sync.",
            };
          else if (!device.revokedAt && !member.active)
            clearCookie(response, "kin_device", secureCookies);
        } catch (error) {
          if (!["household_deletion_pending", "household_deleted"].includes(error.code))
            clearCookie(response, "kin_device", secureCookies);
        }
      }
    }

    try {
      claim = claimToken ? service.pairingForClaim(claimToken) : null;
      if (["Expired", "Revoked"].includes(claim?.state))
        clearCookie(response, "kin_claim", secureCookies);
    } catch {
      clearCookie(response, "kin_claim", secureCookies);
    }
    json(response, 200, { identity, claim, householdLifecycle });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/passkeys/register/options"
  ) {
    if (!["bootstrap", "claim"].includes(body.purpose)) throw badRequest();
    // Refuse before the passkey prompt, not after it (#157).
    if (body.purpose === "bootstrap")
      service.assertBootstrapAllowed(context.clientKey(request));
    let flowPurpose = body.purpose;
    if (body.purpose === "claim") {
      const pairing = service.validatePairingCode(body.code, {
        rateKey: context.clientKey(request),
      });
      if (pairing.purpose !== "adult")
        flowPurpose = `${pairing.purpose}-claim`;
      if (claimToken) {
        service.clearClaim(claimToken);
        clearCookie(response, "kin_claim", secureCookies);
      }
    }
    const issued = issueRegistrationFlow(
      {
        purpose: flowPurpose,
        code: body.code,
        // Only an automatic name is kept, even in memory (#71).
        deviceLabel: deviceLabel(body.deviceLabel),
      },
      context,
      { anonymous: body.purpose === "bootstrap" },
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/passkeys/register/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    const credential = webauthn.verifyRegistration(body.credential, body.flow);
    if (flow.purpose === "bootstrap") {
      const result = service.bootstrap({
        credential,
        deviceLabel: flow.deviceLabel,
        syncPublicKeys: body.syncPublicKeys,
        rateKey: context.clientKey(request),
      });
      cookie(response, "kin_session", result.sessionToken, secureCookies);
      cookie(
        response,
        "kin_device",
        result.deviceToken,
        secureCookies,
        31_536_000,
      );
      json(response, 201, omitToken(result));
      return;
    }
    const result = service.claimPairing({
      code: flow.code,
      credential,
      deviceLabel: flow.deviceLabel,
      syncPublicKeys: body.syncPublicKeys,
      rateKey: context.clientKey(request),
    });
    cookie(response, "kin_claim", result.claimToken, secureCookies);
    cookie(
      response,
      "kin_device",
      result.deviceToken,
      secureCookies,
      31_536_000,
    );
    json(response, 200, omitToken(result));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login/options") {
    const { member, device } = service.trustedDevice(deviceToken);
    const issued = issueAuthenticationFlow(
      { purpose: "login", memberId: member.id, deviceId: device.id },
      [...member.credentials],
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "login") throw badRequest();
    const { member, device } = service.trustedDevice(deviceToken);
    if (flow.memberId !== member.id || flow.deviceId !== device.id)
      throw badRequest();
    const credential = service.credentials.get(body.credential?.id);
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    const result = service.reauthenticate(deviceToken, body.credential.id);
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(
      response,
      "kin_device",
      result.deviceToken,
      secureCookies,
      31_536_000,
    );
    json(response, 200, omitToken(result));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/pairings") {
    json(response, 201, service.createPairing(session, {
      kind: body?.kind ?? "adult",
      ...(body && typeof body === "object" && Object.hasOwn(body, "expiresAt") ? { expiresAt: body.expiresAt } : {}),
    }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/devices/pairings") {
    json(response, 201, service.createDevicePairing(session));
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/devices/replacements"
  ) {
    json(
      response,
      201,
      service.createReplacementPairing(session, body.deviceId),
    );
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/recovery"
  ) {
    json(
      response,
      201,
      service.createMemberRecoveryPairing(session, body.memberId),
    );
    return;
  }
  const pairingMatch = url.pathname.match(/^\/api\/pairings\/([a-f0-9]{32})$/);
  if (request.method === "GET" && pairingMatch) {
    json(response, 200, service.pairingForAdult(session, pairingMatch[1]));
    return;
  }
  if (request.method === "DELETE" && pairingMatch) {
    json(response, 200, service.revokePairing(session, pairingMatch[1]));
    return;
  }
  const approveOptions = url.pathname.match(
    /^\/api\/pairings\/([a-f0-9]{32})\/approve\/options$/,
  );
  if (request.method === "POST" && approveOptions) {
    const auth = service.authorize(session);
    requireTrustAuthority(auth.member, "approve a pairing");
    const ids = [...auth.member.credentials];
    const issued = issueAuthenticationFlow(
      {
        purpose: "approve",
        pairingId: approveOptions[1],
        expectedVersion: body.expectedVersion,
        memberId: auth.member.id,
      },
      ids,
      context,
    );
    json(response, 200, issued);
    return;
  }
  const approveFinish = url.pathname.match(
    /^\/api\/pairings\/([a-f0-9]{32})\/approve\/finish$/,
  );
  if (request.method === "POST" && approveFinish) {
    const auth = service.authorize(session);
    const flow = consumeFlow(body.flow, context);
    if (
      flow.purpose !== "approve" ||
      flow.pairingId !== approveFinish[1] ||
      flow.memberId !== auth.member.id
    )
      throw badRequest();
    const credential = service.credentialForAuthenticatedMember(
      session,
      body.credential?.id,
    );
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    const approved = withTransaction(context, () => {
      const result = service.approvePairing(
        session,
        flow.pairingId,
        flow.expectedVersion,
        body.deviceCertificate,
      );
      const pairing = service.pairings.get(flow.pairingId);
      const device = service.devices.get(pairing?.confirmedDeviceId);
      if (device?.syncPublicKeys && device.syncHistoryFromEpoch == null)
        syncService.onDeviceAdded(auth.household.id, device.id, {
          historyFromEpoch:
            ["device", "replacement", "member-recovery"].includes(
              pairing.purpose,
            )
              ? 1
              : undefined,
        });
      return result;
    });
    // A replacement or recovery revokes old devices: their sockets close now.
    context.liveService.revalidate(auth.household.id);
    json(response, 200, approved);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/claim") {
    const result = service.pairingForClaim(claimToken);
    if (["Expired", "Revoked"].includes(result.state))
      clearCookie(response, "kin_claim", secureCookies);
    json(response, 200, result);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/claim/activate/options"
  ) {
    const credential = service.claimCredential(claimToken);
    const issued = issueAuthenticationFlow(
      {
        purpose: "activate",
        claimToken,
      },
      [credential.id],
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/claim/activate/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "activate" || flow.claimToken !== claimToken)
      throw badRequest();
    webauthn.verifyAuthentication(
      body.credential,
      body.flow,
      service.claimCredential(claimToken),
    );
    const result = service.activateClaim(claimToken);
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(
      response,
      "kin_device",
      result.deviceToken,
      secureCookies,
      31_536_000,
    );
    clearCookie(response, "kin_claim", secureCookies);
    json(response, 200, omitToken(result));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/logout") {
    // Signing out stops this browser's notifications (#85).
    // An expired session still names the browser through its device cookie.
    let signedOutDevice = null;
    try { signedOutDevice = service.authorize(session).device.id; } catch {
      try { signedOutDevice = service.trustedDevice(deviceToken, { allowDeletionPending: true }).device.id; } catch { /* no device */ }
    }
    if (signedOutDevice) context.pushService.signedOut(signedOutDevice);
    service.logout(session);
    if (signedOutDevice) context.liveService.revalidate(service.devices.get(signedOutDevice)?.householdId);
    clearCookie(response, "kin_session", secureCookies);
    json(response, 200, { loggedOut: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/devices") {
    const auth = service.authorize(session);
    json(response, 200, {
      devices: service.listDevices(session),
      canManageMembers: service.canManageMembers(auth.member, auth.household),
    });
    return;
  }
  const revokeOptionsMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9]{32})\/revocation\/options$/);
  if (request.method === "POST" && revokeOptionsMatch) {
    const revocation = service.deviceRevocationContext(session, revokeOptionsMatch[1]);
    const issued = issueAuthenticationFlow(
      {
        purpose: "revoke-device",
        targetDeviceId: revokeOptionsMatch[1],
        memberId: revocation.memberId,
        deviceId: revocation.deviceId,
      },
      revocation.credentialIds,
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/devices/revocation/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "revoke-device") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id)
      throw badRequest();
    const credential = service.credentials.get(body.credential?.id);
    if (!credential || credential.memberId !== auth.member.id)
      throw new PairingError("passkey_member_mismatch", "Use this Adult's passkey to continue.", 401);
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    const target = service.devices.get(flow.targetDeviceId);
    const alreadyRevoked = Boolean(target?.revokedAt);
    const result = withTransaction(context, () => {
      const revoked = service.revokeDevice(session, flow.targetDeviceId, auth.member.id);
      if (target && !alreadyRevoked) syncService.onAccessChange(target.householdId, [target.id]);
      return revoked;
    });
    json(response, 200, result);
    return;
  }
  const deviceMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9]{32})$/);
  if (request.method === "DELETE" && deviceMatch) {
    throw new PairingError("fresh_auth_required", "Authenticate with your passkey before revoking a device.", 401);
  }
  if (request.method === "POST" && url.pathname === "/api/sync/device-keys/successor") {
    const auth = service.authorize(session);
    const result = withTransaction(context, () => {
      const transition = service.transitionSyncPublicKeys(session, body.transition);
      if (!transition.retried)
        syncService.onDeviceKeyTransition(auth.household.id, auth.device.id);
      return transition;
    });
    json(response, 200, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sync/device-keys") {
    const auth = service.authorize(session);
    const keyedDevices = [...service.devices.values()].filter(
      (device) =>
        device.householdId === auth.household.id &&
        !device.revokedAt &&
        device.syncPublicKeys,
    ).length;
    const result = withTransaction(context, () => {
      const registered = service.registerSyncPublicKeys(session, body.publicKeys);
      if (registered.registered && keyedDevices > 0)
        syncService.onDeviceAdded(auth.household.id, auth.device.id, {
          historyFromEpoch: 1,
        });
      return registered;
    });
    json(response, 200, result);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/status") {
    json(response, 200, syncService.status(session));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/household/settings") {
    json(response, 200, syncService.householdSettings(session));
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/household/settings") {
    const expectedRevision = request.headers["x-household-settings-revision"];
    const keyEpoch = request.headers["x-household-settings-key-epoch"];
    const digest = request.headers["x-household-settings-sha256"];
    if (!/^\d+$/.test(expectedRevision ?? "") || !/^[1-9]\d{0,2}$/.test(keyEpoch ?? "") || typeof digest !== "string") throw badRequest();
    json(response, 200, syncService.updateHouseholdSettings(session, { expectedRevision: Number(expectedRevision), keyEpoch: Number(keyEpoch), digest, ciphertext: body }));
    return;
  }
  if (url.pathname === "/api/household/install-identity") {
    if (request.method === "GET") {
      json(response, 200, syncService.installIdentity(session));
      return;
    }
    if (request.method === "PUT") {
      json(response, 200, withTransaction(context, () => syncService.publishInstallIdentity(session, body)));
      return;
    }
    if (request.method === "DELETE") {
      json(response, 200, withTransaction(context, () => syncService.withdrawInstallIdentity(session, body.expectedRev)));
      return;
    }
  }
  if (chatUploadAuth) {
    // Authorized (and rate-limited) once, before the body was read.
    json(response, 200, withTransaction(context, () => context.chatBlobService.put(chatUploadAuth, chatBlobRoute, body)));
    return;
  }
  if (chatBlobRoute && request.method === "GET") {
    const bytes = context.chatBlobService.get(syncService.authorize(session), chatBlobRoute);
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" });
    response.end(bytes);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat/blobs/retire") {
    const auth = syncService.authorize(session);
    // Not in an outer transaction: the store zeroes freed pages and then
    // checkpoints the WAL, which needs no transaction open.
    json(response, 200, context.chatBlobService.retire(auth, body?.refs));
    return;
  }
  if (url.pathname.startsWith("/api/push/")) {
    const auth = syncService.authorize(session);
    const { pushService } = context;
    if (request.method === "GET" && url.pathname === "/api/push/vapid-public-key") {
      json(response, 200, { publicKey: pushService.publicKey() });
      return;
    }
    if (url.pathname === "/api/push/subscription") {
      if (request.method === "GET") { json(response, 200, pushService.status(auth)); return; }
      if (request.method === "PUT") { json(response, 200, withTransaction(context, () => pushService.subscribe(auth, body))); return; }
      if (request.method === "DELETE") { json(response, 200, withTransaction(context, () => pushService.unsubscribe(auth))); return; }
    }
    if (request.method === "PUT" && url.pathname === "/api/push/mute") {
      json(response, 200, withTransaction(context, () => pushService.mute(auth, body.choice ?? null)));
      return;
    }
  }
  if (request.method === "POST" && url.pathname === "/api/sync/enable") {
    json(response, 200, syncService.enable(session));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/devices") {
    json(response, 200, {
      devices: syncService.deviceDirectory(session),
      members: syncService.membershipDirectory(session),
    });
    return;
  }
  if (envelopePush && url.pathname === "/api/sync/events") {
    json(response, 200, syncService.push(session, body));
    return;
  }
  if (url.pathname === "/api/chat/events" && request.method === "POST") {
    const auth = syncService.authorize(session);
    json(response, 200, withTransaction(context, () => context.chatRelayService.push(auth, body)));
    return;
  }
  if (url.pathname === "/api/chat/status" && request.method === "GET") {
    json(response, 200, context.chatRelayService.status(syncService.authorize(session)));
    return;
  }
  if (url.pathname === "/api/chat/events" && request.method === "GET") {
    const auth = syncService.authorize(session);
    let page;
    try {
      page = context.chatRelayService.pull(auth, url.searchParams.get("cursor") ?? "", url.searchParams.get("limit") ?? undefined);
      binary(response, encodeEventPage(page));
    } catch (error) {
      if (!(error instanceof EnvelopeWireError) &&
          !(error instanceof DurableStoreError && error.code === "sync_store_invalid")) throw error;
      console.error(JSON.stringify({ event: "chat_store_invalid", householdId: auth.household.id }));
      throw new PairingError("sync_store_invalid", "Kin's stored chat history is invalid.", 500);
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/events") {
    const { household } = service.authorize(session);
    let page;
    try {
      page = syncService.pull(
        session,
        url.searchParams.get("cursor") ?? "",
        url.searchParams.get("limit") ?? "20",
      );
      binary(response, encodeEventPage(page));
    } catch (error) {
      if (!(error instanceof EnvelopeWireError) &&
          !(error instanceof DurableStoreError && error.code === "sync_store_invalid")) throw error;
      const eventId = error.eventId ?? page?.events.find((row) => !isEventEnvelopeValid(row.envelope))?.envelope.eventId;
      console.error(JSON.stringify({
        event: "sync_store_invalid",
        householdId: household.id,
        eventId: isSyncId(eventId) ? eventId : null,
      }));
      throw new PairingError("sync_store_invalid", "Kin's stored sync history is invalid. Repair the development store before retrying.", 500);
    }
    return;
  }
  const attachmentRoute = url.pathname.match(/^\/api\/sync\/attachments(?:\/([a-f0-9]{32}))?$/);
  if (attachmentRoute && request.method === "GET" && !attachmentRoute[1]) {
    json(response, 200, { attachments: syncService.listAttachments(session) });
    return;
  }
  if (attachmentRoute && request.method === "POST" && attachmentRoute[1]) {
    const keyEpoch = request.headers["x-attachment-key-epoch"];
    const digest = request.headers["x-attachment-sha256"];
    if (typeof keyEpoch !== "string" || !/^[1-9][0-9]{0,2}$/.test(keyEpoch) || typeof digest !== "string") throw badRequest();
    json(response, 200, syncService.pushAttachment(session, { attachmentId: attachmentRoute[1], keyEpoch: Number(keyEpoch), ciphertext: body, digest }));
    return;
  }
  if (attachmentRoute && request.method === "GET" && attachmentRoute[1]) {
    const attachment = syncService.getAttachment(session, attachmentRoute[1]);
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": attachment.ciphertext.length, "Cache-Control": "no-store", "X-Attachment-Key-Epoch": String(attachment.keyEpoch), "X-Attachment-SHA256": attachment.digest });
    response.end(attachment.ciphertext);
    return;
  }
  if (attachmentRoute && request.method === "DELETE" && attachmentRoute[1]) {
    json(response, 200, syncService.removeAttachment(session, attachmentRoute[1]));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sync/bindings") {
    json(response, 200, syncService.pushBindings(session, body.bindings));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/bindings") {
    json(
      response,
      200,
      syncService.pullBindings(session, url.searchParams.get("cursor") ?? ""),
    );
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/sync/provisioning/grants"
  ) {
    json(response, 201, syncService.createProvisioningGrant(session, body));
    return;
  }
  const provisioningUpload = url.pathname.match(
    /^\/api\/sync\/provisioning\/grants\/([a-f0-9]{32})$/,
  );
  if (request.method === "POST" && provisioningUpload) {
    json(
      response,
      200,
      syncService.submitProvisioning(
        session,
        provisioningUpload[1],
        body.package,
      ),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/provisioning") {
    json(response, 200, { grants: syncService.pendingProvisioning(session) });
    return;
  }
  const provisioningAck = url.pathname.match(
    /^\/api\/sync\/provisioning\/([a-f0-9]{32})\/ack$/,
  );
  if (request.method === "POST" && provisioningAck) {
    json(
      response,
      200,
      syncService.acknowledgeProvisioning(session, provisioningAck[1]),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sync/epochs") {
    json(response, 200, syncService.rotateEpoch(session, body));
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/deletion/options"
  ) {
    const auth = service.authorize(session);
    service.requireManagementAuthority(auth.member, auth.household, "delete the household");
    const issued = issueAuthenticationFlow(
      {
        purpose: "delete-household",
        householdId: auth.household.id,
        memberId: auth.member.id,
        deviceId: auth.device.id,
      },
      [...auth.member.credentials],
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/deletion/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    const auth = service.authorize(session);
    if (
      flow.purpose !== "delete-household" ||
      flow.householdId !== auth.household.id ||
      flow.memberId !== auth.member.id ||
      flow.deviceId !== auth.device.id
    )
      throw badRequest();
    const credential = service.credentialForAuthenticatedMember(
      session,
      body.credential?.id,
    );
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    const result = withTransaction(context, () =>
      service.requestHouseholdDeletion(session, auth.member.id),
    );
    for (const [flowId, activeFlow] of context.flows)
      if (
        activeFlow.householdId === auth.household.id ||
        auth.household.members.has(activeFlow.memberId)
      )
        context.flows.delete(flowId);
    context.liveService.revalidate(auth.household.id);
    clearCookie(response, "kin_session", secureCookies);
    json(response, 200, {
      ...result,
      cancelable: true,
      message:
        "Household sync is stopped. Deletion becomes final after 30 days unless an adult cancels it with a passkey.",
    });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/deletion/cancel/options"
  ) {
    const { device, member } = service.trustedDevice(deviceToken, {
      allowDeletionPending: true,
    });
    const household = service.households.get(member.householdId);
    if (household) service.requireManagementAuthority(member, household, "cancel household deletion");
    else requireTrustAuthority(member, "cancel household deletion");
    if (household?.lifecycleState !== "deletion_pending")
      throw new PairingError(
        "household_deletion_unavailable",
        "There is no pending household deletion to cancel.",
        409,
      );
    const issued = issueAuthenticationFlow(
      {
        purpose: "cancel-household-deletion",
        householdId: household.id,
        memberId: member.id,
        deviceId: device.id,
      },
      [...member.credentials],
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/deletion/cancel/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    const { device, member } = service.trustedDevice(deviceToken, {
      allowDeletionPending: true,
    });
    if (
      flow.purpose !== "cancel-household-deletion" ||
      flow.householdId !== member.householdId ||
      flow.memberId !== member.id ||
      flow.deviceId !== device.id
    )
      throw badRequest();
    const credential = service.credentials.get(body.credential?.id);
    if (!credential || credential.memberId !== member.id)
      throw new PairingError(
        "passkey_member_mismatch",
        "Use this member's passkey to continue.",
        401,
      );
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    const result = withTransaction(context, () =>
      service.cancelHouseholdDeletion(deviceToken, credential.id),
    );
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(
      response,
      "kin_device",
      result.deviceToken,
      secureCookies,
      31_536_000,
    );
    json(response, 200, {
      householdId: result.householdId,
      memberId: result.memberId,
      deviceId: result.deviceId,
      state: "active",
      message: "Household deletion was cancelled. Sync can be started again.",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/household") {
    json(response, 200, service.householdView(session));
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/membership/remove/options"
  ) {
    const removal = service.removalContext(session, body.memberId, { allowSelf: true });
    const issued = issueAuthenticationFlow(
      {
        purpose: "remove-adult",
        targetMemberId: body.memberId,
        memberId: removal.memberId,
        deviceId: removal.deviceId,
      },
      removal.credentialIds,
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/membership/remove/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "remove-adult") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id)
      throw badRequest();
    const credential = service.credentials.get(body.credential?.id);
    if (!credential || credential.memberId !== auth.member.id)
      throw new PairingError(
        "passkey_member_mismatch",
        "Use this member's passkey to continue.",
        401,
      );
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    const leaving = flow.targetMemberId === auth.member.id;
    const excludedDevices = [...service.devices.values()]
      .filter((device) => device.memberId === flow.targetMemberId)
      .map((device) => device.id);
    const result = withTransaction(context, () => {
      const removed = leaving
        ? service.leaveHousehold(session, auth.member.id)
        : service.removeOtherAdult(session, flow.targetMemberId, auth.member.id);
      syncService.onAccessChange(auth.household.id, excludedDevices);
      return removed;
    });
    if (leaving) {
      clearCookie(response, "kin_session", secureCookies);
      clearCookie(response, "kin_device", secureCookies);
    }
    json(response, 200, result);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/admins/options"
  ) {
    if (typeof body?.admin !== "boolean") throw badRequest();
    const change = service.householdAdminContext(session, body.memberId);
    const issued = issueAuthenticationFlow(
      {
        purpose: "set-household-admin",
        targetMemberId: body.memberId,
        admin: body.admin,
        memberId: change.memberId,
        deviceId: change.deviceId,
      },
      change.credentialIds,
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/admins/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "set-household-admin") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id)
      throw badRequest();
    const credential = service.credentials.get(body.credential?.id);
    if (!credential || credential.memberId !== auth.member.id)
      throw new PairingError(
        "passkey_member_mismatch",
        "Use this member's passkey to continue.",
        401,
      );
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    json(
      response,
      200,
      withTransaction(context, () =>
        service.setHouseholdAdmin(session, flow.targetMemberId, flow.admin, auth.member.id),
      ),
    );
    return;
  }
  if (
    request.method === "DELETE" &&
    url.pathname === "/api/household/membership"
  ) {
    throw new PairingError(
      "fresh_auth_required",
      "Authenticate with your passkey again before removing a household adult or leaving.",
      401,
    );
  }
  throw new PairingError("not_found", "That endpoint is unavailable.", 404);
}

function withTransaction(context, operation) {
  return context.store ? context.store.transaction(operation) : operation();
}

function installShutdown({ server, store }) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "shutdown_started", signal }));
    const timeout = setTimeout(() => {
      console.error(JSON.stringify({ event: "shutdown_timeout" }));
      store?.close();
      process.exitCode = 1;
    }, 30_000);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);
      if (error) {
        console.error(JSON.stringify({ event: "shutdown_failed" }));
        process.exitCode = 1;
      }
      store?.close();
    });
  };
  // `on`, not `once`: a terminal's Ctrl+C reaches the service and its
  // launcher together, and the launcher forwards a stop too. A repeated
  // signal must not kill the service before it closes the store and its lock.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function defaultAnonymousCapacity(maximum) {
  return maximum > 1 ? Math.max(1, Math.floor(maximum / 4)) : 0;
}

function createFlow(value, context, { anonymous = false } = {}) {
  pruneFlows(context);
  if (
    anonymous &&
    [...context.flows.values()].filter((flow) => flow.anonymous).length >=
      context.maxAnonymousFlows
  )
    throw new PairingError(
      "flow_capacity",
      "Too many active passkey requests. Wait and try again.",
      503,
    );
  if (context.flows.size >= context.maxFlows)
    throw new PairingError(
      "flow_capacity",
      "Too many active passkey requests. Wait and try again.",
      503,
    );
  const flow = randomBytes(18).toString("base64url");
  context.flows.set(flow, {
    ...value,
    anonymous,
    expiresAt: context.now() + FLOW_TTL_MS,
  });
  return flow;
}

function issueRegistrationFlow(value, context, { anonymous = false } = {}) {
  const flow = createFlow(value, context, { anonymous });
  try {
    return {
      flow,
      publicKey: context.webauthn.registrationOptions(flow, { anonymous }),
    };
  } catch (error) {
    context.flows.delete(flow);
    context.webauthn.discardFlow?.(flow);
    throw error;
  }
}

function issueAuthenticationFlow(value, credentialIds, context) {
  const flow = createFlow(value, context);
  try {
    return {
      flow,
      publicKey: context.webauthn.authenticationOptions(flow, credentialIds),
    };
  } catch (error) {
    context.flows.delete(flow);
    context.webauthn.discardFlow?.(flow);
    throw error;
  }
}

function pruneFlows({ flows, now }) {
  const timestamp = now();
  for (const [key, flow] of flows)
    if (flow.expiresAt <= timestamp) flows.delete(key);
}

function consumeFlow(value, context) {
  pruneFlows(context);
  const flowKey = String(value ?? "");
  const flow = context.flows.get(flowKey);
  context.flows.delete(flowKey);
  if (!flow || flow.expiresAt <= context.now())
    throw new PairingError(
      "challenge_expired",
      "That passkey request expired. Try again.",
      410,
    );
  return flow;
}

function omitToken(value) {
  const { sessionToken, claimToken, deviceToken, ...safe } = value;
  return safe;
}
function badRequest() {
  return new PairingError(
    "invalid_request",
    "Kin could not understand that request.",
  );
}
function cookie(response, name, value, secure, maxAge = 43_200) {
  response.appendHeader(
    "Set-Cookie",
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}
function clearCookie(response, name, secure) {
  response.appendHeader(
    "Set-Cookie",
    `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}
function cookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2),
  );
}

// JSON request bodies are small control messages; attachments and settings
// are binary and bounded by the attachment limit (http-body.mjs).
const MAX_JSON_BODY_BYTES = 256_000;
// Four base64url PNGs of at most 512 KB each, plus the names.
const MAX_INSTALL_IDENTITY_BODY_BYTES = 2_850_000;

// Header 8 + 20 * (fixed record 148 + max ciphertext 6,144) = 125,848 bytes.
const MAX_ENVELOPE_PUSH_BYTES = 8 + MAX_EVENTS_PER_BATCH * (RECORD_FIXED + MAX_CIPHERTEXT_BYTES);

async function readEnvelopeBatch(request, response) {
  const mediaType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== ENVELOPE_CONTENT_TYPE)
    throw new PairingError("unsupported_media_type", "Send sync events as a binary batch.", 415);
  const bytes = await readBody(request, response, MAX_ENVELOPE_PUSH_BYTES, "That sync batch is too large.");
  try {
    return decodeEnvelopeBatch(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { maxCount: MAX_EVENTS_PER_BATCH });
  } catch (error) {
    if (error instanceof EnvelopeWireError) throw new PairingError("sync_batch_invalid", "That sync batch is invalid.", 400);
    throw error;
  }
}

async function readBinary(request, response) {
  const body = await readBody(request, response, MAX_ATTACHMENT_BYTES, "That attachment is larger than Kin supports.");
  if (!body.length) throw badRequest();
  return body;
}

function binary(response, bytes) {
  if (response.headersSent) return;
  response.writeHead(200, {
    "Content-Type": ENVELOPE_CONTENT_TYPE,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

function json(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function setHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
}
// The service worker keys its shell cache by the release in the registration
// URL and refuses to re-stage an existing cache name. Appending a fingerprint
// of the served files as semver build metadata means any changed shell gets a
// new cache instead of leaving browsers on a frozen snapshot. Static test
// servers serve the raw file, so the plain release still works.
//
// A file or folder can disappear between listing and reading it (an editor's
// temporary file, a test's scratch folder). That entry is skipped rather than
// failing the page with a 500: it isn't part of the shell either way. Windows
// reports an entry that is being deleted as EPERM rather than ENOENT.
const vanished = (error) =>
  error?.code === "ENOENT" || error?.code === "ENOTDIR" ||
  (process.platform === "win32" && error?.code === "EPERM");
export function shellFingerprint(root = webRoot) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (directory !== root && vanished(error)) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !entry.name.endsWith(".test.mjs")) {
        const name = relative(root, path).replaceAll("\\", "/");
        let content;
        try { content = readFileSync(path); } catch (error) {
          if (vanished(error)) continue;
          throw error;
        }
        hash.update(`${name.length}:${name}:${content.length}:`);
        hash.update(content);
        hash.update("\n");
      }
    }
  };
  visit(root);
  return hash.digest("hex").slice(0, 12);
}

export function fingerprintedShell(html, fingerprint) {
  return html.replace(
    /(<meta name="kin-version" content="\d+\.\d+\.\d+)(")/,
    (_, prefix, quote) => `${prefix}+${fingerprint}${quote}`,
  );
}

// New routes match with URLPattern (#106) rather than hand-written parsing.
const INSTALL_ICON_ROUTE = new URLPattern({ pathname: "/install-icon/:file([a-z0-9\\-]+[.]png)" });
const CHAT_BLOB_ROUTE = new URLPattern({ pathname: "/api/chat/blobs/:ref([a-f0-9]{64})" });

// The install identity (#78) a trusted device's kin_device cookie resolves
// to, or the built-in Kin manifest and icon. Always private to the browser
// and never cached by the service worker (web/service-worker.js).
function serveManifest(request, response, context) {
  const resolved = context.syncService.installIdentityForDevice(cookies(request).kin_device);
  const { body, etag } = resolved ? publishedManifest(resolved.householdId, resolved.identity) : builtInManifest();
  const headers = {
    "Content-Type": "application/manifest+json",
    "Cache-Control": "private, no-cache",
    Vary: "Cookie",
    ETag: etag,
  };
  if (etagMatches(request.headers["if-none-match"], etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, "Content-Length": body.length });
  response.end(request.method === "HEAD" ? undefined : body);
}

function serveInstallIcon(request, response, url, file, context) {
  const icon = INSTALL_ICONS.find((entry) => entry.file === file);
  const resolved = icon && context.syncService.installIdentityForDevice(cookies(request).kin_device);
  const published = resolved && context.syncService.publishedInstallIcon(resolved.householdId, icon.key);
  if (!published) {
    // Kin has no PNG icon, and iOS ignores an SVG touch icon. A 404 keeps
    // iOS's own behaviour from before (a screenshot), as it was until #78.
    if (file === "apple-180.png") {
      response.writeHead(404, { "Cache-Control": "private, no-cache", Vary: "Cookie" });
      response.end();
      return;
    }
    // The built-in Kin icon stands in for the other sizes.
    const body = readFileSync(join(webRoot, "icon.svg"));
    response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "private, no-cache", Vary: "Cookie", "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  const body = published;
  // A URL naming the current content never changes; any other (the
  // unversioned apple-touch-icon link, earlier content) is revalidated.
  const current = url.searchParams.get("v") === resolved.identity.contentTag;
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": current ? "private, max-age=31536000, immutable" : "private, no-cache",
    Vary: "Cookie",
    "Content-Length": body.length,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function serve(response, pathname) {
  let requested;
  try {
    requested =
      pathname === "/" || pathname === "/pair"
        ? "index.html"
        : decodeURIComponent(pathname.slice(1));
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    // A malformed percent-escape names no file: a client error, not a
    // server failure, so it is not logged as one.
    requested = null;
  }
  let path;
  try {
    if (requested === null) throw new URIError("malformed path");
    const candidate = resolve(webRoot, requested);
    if (isInsideRoot(candidate, webRoot)) {
      const canonical = realpathSync(candidate);
      if (
        isInsideRoot(canonical, realpathSync(webRoot)) &&
        statSync(canonical).isFile()
      )
        path = canonical;
    }
  } catch {
    // Missing files and inaccessible paths are not static assets.
  }
  if (!path) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    // The chat emoji table (#113).
    ".json": "application/json; charset=utf-8",
  };
  if (requested === "index.html") {
    let body;
    try {
      body = Buffer.from(fingerprintedShell(readFileSync(path, "utf8"), shellFingerprint()), "utf8");
    } catch {
      response.writeHead(500);
      response.end("Kin could not prepare its application shell.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[".html"],
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    response.end(body);
    return;
  }
  response.writeHead(200, {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  createReadStream(path).pipe(response);
}
