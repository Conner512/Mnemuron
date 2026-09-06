import http from "node:http";
import { URL } from "node:url";
import {
  AuthenticationError,
  MnemuronStore,
  NotFoundError,
  ValidationError,
} from "./store.mjs";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function readJson(request, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        return;
      }
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ValidationError("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string"
    ? authorization.match(/^Bearer\s+(.+)$/i)
    : null;
  if (!match) throw new AuthenticationError("Bearer API credential is required.");
  return match[1];
}

function routeMatch(pathname, expression) {
  const match = pathname.match(expression);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

export function createMnemuronApp({
  databasePath,
  defaultRetentionDays = 30,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  logger = null,
} = {}) {
  if (!databasePath) throw new Error("databasePath is required.");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive integer.");
  }
  const store = new MnemuronStore(databasePath, { defaultRetentionDays });

  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    let responseStatus = 500;
    try {
      const url = new URL(request.url, "http://mnemuron.local");
      const { pathname } = url;

      if (request.method === "GET" && pathname === "/livez") {
        responseStatus = 200;
        return sendJson(response, 200, { status: "ok", service: "mnemuron" });
      }
      if (request.method === "GET" && pathname === "/readyz") {
        store.db.prepare("SELECT 1 AS ready").get();
        responseStatus = 200;
        return sendJson(response, 200, { status: "ready" });
      }

      const auth = store.authenticate(bearerToken(request));

      if (request.method === "GET" && pathname === "/readyz/search") {
        store.requireScope(auth, "memory:read");
        const search = store.memorySearch.status();
        const ready = search.state === "ready";
        responseStatus = ready ? 200 : 503;
        return sendJson(response, responseStatus, {
          status: ready ? "ready" : "unavailable",
          component: "memory_search",
          ready,
          index_version: search.index_version,
          enabled: search.enabled,
          ...(ready ? {} : { error_code: "SEARCH_UNAVAILABLE" }),
        });
      }
      if (request.method === "GET" && pathname === "/v1/status") {
        responseStatus = 200;
        return sendJson(response, 200, store.status(auth));
      }
      if (request.method === "POST" && pathname === "/v1/events") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 202;
        return sendJson(response, 202, store.appendEvents(auth, body));
      }
      const checkpoint = routeMatch(pathname, /^\/v1\/sessions\/([^/]+)\/checkpoint$/);
      if (request.method === "POST" && checkpoint) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 201;
        return sendJson(response, 201, store.createCheckpoint(auth, checkpoint[0], body));
      }
      const taskCheckpoints = routeMatch(pathname, /^\/v1\/tasks\/([^/]+)\/checkpoints$/);
      if (request.method === "GET" && taskCheckpoints) {
        responseStatus = 200;
        return sendJson(response, 200, {
          checkpoints: store.listCheckpoints(
            auth,
            taskCheckpoints[0],
            url.searchParams.get("workstream_id"),
            url.searchParams.get("limit"),
          ),
        });
      }
      const taskReconciliation = routeMatch(
        pathname,
        /^\/v1\/tasks\/([^/]+)\/reconciliation$/,
      );
      if (request.method === "GET" && taskReconciliation) {
        responseStatus = 200;
        return sendJson(response, 200, store.reconciliationState(auth, taskReconciliation[0]));
      }
      const runTaskReconciliation = routeMatch(
        pathname,
        /^\/v1\/tasks\/([^/]+)\/reconciliation\/run$/,
      );
      if (request.method === "POST" && runTaskReconciliation) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 201;
        return sendJson(
          response,
          201,
          store.runReconciliation(auth, runTaskReconciliation[0], body),
        );
      }
      const taskCanonicalRevisions = routeMatch(
        pathname,
        /^\/v1\/tasks\/([^/]+)\/canonical-revisions$/,
      );
      if (request.method === "GET" && taskCanonicalRevisions) {
        responseStatus = 200;
        return sendJson(response, 200, {
          revisions: store.listCanonicalRevisions(
            auth,
            taskCanonicalRevisions[0],
            url.searchParams.get("limit"),
          ),
        });
      }
      const resolveTaskReconciliation = routeMatch(
        pathname,
        /^\/v1\/task-reconciliations\/([^/]+)\/resolve$/,
      );
      if (request.method === "POST" && resolveTaskReconciliation) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(
          response,
          200,
          store.resolveReconciliation(auth, resolveTaskReconciliation[0], body),
        );
      }
      if (request.method === "POST" && pathname === "/v1/memories") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 201;
        return sendJson(response, 201, store.saveMemory(auth, body, {
          idempotencyKey: request.headers["idempotency-key"],
        }));
      }
      if (request.method === "POST" && pathname === "/v1/memories/query") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.queryMemories(auth, body));
      }
      const supersedeMemory = routeMatch(pathname, /^\/v1\/memories\/([^/]+)\/supersede$/);
      if (request.method === "POST" && supersedeMemory) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.supersedeMemory(auth, supersedeMemory[0], body));
      }
      const retractMemory = routeMatch(pathname, /^\/v1\/memories\/([^/]+)\/retract$/);
      if (request.method === "POST" && retractMemory) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.retractMemory(auth, retractMemory[0], body));
      }
      const deleteMemory = routeMatch(pathname, /^\/v1\/memories\/([^/]+)$/);
      if (request.method === "GET" && deleteMemory) {
        responseStatus = 200;
        const options = {};
        if (url.searchParams.has('include_history')) {
          const value = url.searchParams.get('include_history');
          if (!['true','false'].includes(value)) throw new ValidationError('include_history must be true or false.');
          options.include_history = value === 'true';
        }
        for (const field of ['content_offset','content_limit']) if (url.searchParams.has(field)) options[field] = Number(url.searchParams.get(field));
        return sendJson(response, 200, store.memoryDetail(auth, deleteMemory[0], options));
      }
      if (request.method === "DELETE" && deleteMemory) {
        responseStatus = 200;
        return sendJson(response, 200, store.retractMemory(auth, deleteMemory[0], {
          reason: "Explicit delete request retained as a lifecycle tombstone.",
        }));
      }
      if (request.method === "POST" && pathname === "/v1/projects/resolve") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.resolveProject(auth, body));
      }
      if (request.method === "POST" && pathname === "/v1/project-context/preview") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.previewProjectContext(auth, body));
      }
      if (request.method === "POST" && pathname === "/v1/task-branches/preview") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.previewTaskBranches(auth, body));
      }
      if (request.method === "POST" && pathname === "/v1/tasks/resolve") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.resolveTask(auth, body));
      }
      if (request.method === "POST" && pathname === "/v1/project-bootstrap/preview") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 201;
        return sendJson(response, 201, store.createProjectBootstrapPreview(auth, body));
      }
      const confirmProjectBootstrap = routeMatch(
        pathname,
        /^\/v1\/project-bootstrap\/([^/]+)\/confirm$/,
      );
      if (request.method === "POST" && confirmProjectBootstrap) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.confirmProjectBootstrap(
          auth,
          confirmProjectBootstrap[0],
          body.preview_version,
          body.confirmed,
          body.session_id,
        ));
      }
      if (request.method === "POST" && pathname === "/v1/task-bootstrap/preview") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 201;
        return sendJson(response, 201, store.createTaskBootstrapPreview(auth, body));
      }
      const confirmTaskBootstrap = routeMatch(
        pathname,
        /^\/v1\/task-bootstrap\/([^/]+)\/confirm$/,
      );
      if (request.method === "POST" && confirmTaskBootstrap) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.confirmTaskBootstrap(
          auth,
          confirmTaskBootstrap[0],
          body.preview_version,
          body.confirmed,
          body.session_id,
        ));
      }
      if (request.method === "POST" && pathname === "/v1/resume/preview") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 201;
        return sendJson(response, 201, store.createPreview(auth, body));
      }

      const confirm = routeMatch(pathname, /^\/v1\/resume\/([^/]+)\/confirm$/);
      if (request.method === "POST" && confirm) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.confirmPreview(
          auth,
          confirm[0],
          body.preview_version,
          body.confirmed,
        ));
      }

      const injectionEvents = routeMatch(pathname, /^\/v1\/resume\/([^/]+)\/injection-events$/);
      if (request.method === "POST" && injectionEvents) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 202;
        return sendJson(response, 202, store.recordInjectionEvent(auth, injectionEvents[0], body));
      }
      const injectionStatus = routeMatch(pathname, /^\/v1\/resume\/([^/]+)\/injection-status$/);
      if (request.method === "GET" && injectionStatus) {
        responseStatus = 200;
        return sendJson(response, 200, store.injectionStatus(auth, injectionStatus[0]));
      }
      const deliveryReceipts = routeMatch(pathname, /^\/v1\/resume\/([^/]+)\/delivery-receipts$/);
      if (request.method === "POST" && deliveryReceipts) {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 202;
        return sendJson(response, 202, store.recordDeliveryReceipt(auth, deliveryReceipts[0], body));
      }
      const deliveryReceiptStatus = routeMatch(
        pathname,
        /^\/v1\/resume\/([^/]+)\/delivery-receipt-status$/,
      );
      if (request.method === "GET" && deliveryReceiptStatus) {
        responseStatus = 200;
        return sendJson(response, 200, store.deliveryReceiptStatus(auth, deliveryReceiptStatus[0]));
      }

      if (request.method === "POST" && pathname === "/v1/agent-instances/register") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 201;
        return sendJson(response, 201, store.registerAgent(auth, body));
      }
      const rotate = routeMatch(pathname, /^\/v1\/agent-instances\/([^/]+)\/rotate-key$/);
      if (request.method === "POST" && rotate) {
        responseStatus = 201;
        return sendJson(response, 201, store.rotateAgentKey(auth, rotate[0]));
      }
      const revoke = routeMatch(pathname, /^\/v1\/agent-instances\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revoke) {
        responseStatus = 200;
        return sendJson(response, 200, store.revokeAgent(auth, revoke[0]));
      }
      if (request.method === "POST" && pathname === "/v1/tasks") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.upsertTask(auth, body));
      }
      if (request.method === "POST" && pathname === "/v1/projects") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.upsertProject(auth, body));
      }
      if (request.method === "POST" && pathname === "/v1/retention/prune") {
        responseStatus = 200;
        return sendJson(response, 200, store.pruneExpired(auth));
      }
      if (request.method === "GET" && pathname === "/v1/retention") {
        store.requireScope(auth, "memory:read");
        responseStatus = 200;
        return sendJson(response, 200, store.getRetention());
      }
      if (request.method === "PUT" && pathname === "/v1/retention") {
        const body = await readJson(request, maxBodyBytes);
        responseStatus = 200;
        return sendJson(response, 200, store.setRetention(auth, body.raw_retention_days));
      }
      if (request.method === "GET" && pathname === "/v1/audit") {
        responseStatus = 200;
        return sendJson(response, 200, {
          events: store.listAudit(auth, url.searchParams.get("limit")),
        });
      }

      throw new NotFoundError("Endpoint not found.");
    } catch (error) {
      responseStatus = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      if (!response.headersSent) {
        sendJson(response, responseStatus, {
          error: responseStatus >= 500 ? "Internal server error." : error.message,
          error_code: responseStatus >= 500 && error.errorCode !== 'SEARCH_UNAVAILABLE' ? "INTERNAL_ERROR" : error.errorCode
            || (responseStatus === 413 ? "REQUEST_BODY_TOO_LARGE" : "REQUEST_FAILED"),
        });
      }
    } finally {
      logger?.({
        method: request.method,
        path: request.url?.split("?")[0],
        status: responseStatus,
        duration_ms: Date.now() - startedAt,
      });
    }
  });

  return {
    server,
    store,
    listen({ host = "127.0.0.1", port = 47831 } = {}) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          store.close();
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
