import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import {
  listOutbox,
  listDeliveryReceiptOutbox,
  listInjectionEventOutbox,
  loadRuntimeEnv,
  markMcpDeliveryAcknowledgementReported,
  quarantineOutboxItem,
  removeOutboxItem,
  resolveApiKey,
  resolveDataDir,
} from "./storage.mjs";

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function remoteSettings(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  if (!runtimeEnv.MNEMURON_SERVER_URL) {
    throw new Error("Mnemuron remote mode requires server_url.");
  }
  const baseUrl = new URL(runtimeEnv.MNEMURON_SERVER_URL);
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("Mnemuron server_url must use http or https.");
  }
  if (baseUrl.protocol === "http:" && !truthy(runtimeEnv.MNEMURON_ALLOW_INSECURE_HTTP)) {
    throw new Error("Plain HTTP is disabled. Configure HTTPS or explicitly set allow_insecure_http for a temporary SD-WAN test.");
  }
  const timeoutMs = Number(runtimeEnv.MNEMURON_REQUEST_TIMEOUT_MS || "5000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 60_000) {
    throw new Error("request_timeout_ms must be an integer from 250 to 60000.");
  }
  return {
    runtimeEnv,
    baseUrl,
    apiKey: resolveApiKey(runtimeEnv),
    timeoutMs,
    ca: runtimeEnv.MNEMURON_TLS_CA_FILE
      ? readFileSync(runtimeEnv.MNEMURON_TLS_CA_FILE)
      : undefined,
  };
}

export function remoteRequest(env, method, endpoint, body = undefined) {
  const settings = remoteSettings(env);
  const target = new URL(endpoint, settings.baseUrl);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method,
      timeout: settings.timeoutMs,
      ca: settings.ca,
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        accept: "application/json",
        ...(payload ? {
          "content-type": "application/json",
          "content-length": payload.length,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let data;
        try {
          data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        } catch {
          reject(new Error(`Mnemuron server returned invalid JSON (${response.statusCode}).`));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(data.error || `Mnemuron server request failed (${response.statusCode}).`);
          error.statusCode = response.statusCode;
          error.responseData = data;
          reject(error);
          return;
        }
        resolve(data);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Mnemuron server request timed out.")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export function eventEnvelope(event, env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  return {
    event,
    raw_retention_days: runtimeEnv.MNEMURON_RAW_RETENTION_DAYS || 30,
  };
}

export function submitEvent(event, env = process.env) {
  return remoteRequest(env, "POST", "/v1/events", eventEnvelope(event, env));
}

export function submitInjectionEvent(resumeId, payload, env = process.env) {
  return remoteRequest(
    env,
    "POST",
    `/v1/resume/${encodeURIComponent(resumeId)}/injection-events`,
    payload,
  );
}

export function submitDeliveryReceipt(resumeId, payload, env = process.env) {
  return remoteRequest(
    env,
    "POST",
    `/v1/resume/${encodeURIComponent(resumeId)}/delivery-receipts`,
    payload,
  );
}

export async function flushDeliveryReceiptOutbox(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const queued = listDeliveryReceiptOutbox(resolveDataDir(runtimeEnv));
  let flushed = 0;
  for (const item of queued) {
    await submitDeliveryReceipt(item.resume_id, item.payload, runtimeEnv);
    if (item.payload.phase === "acknowledged") {
      markMcpDeliveryAcknowledgementReported(
        resolveDataDir(runtimeEnv),
        item.payload.receipt_event_id,
      );
    }
    removeOutboxItem(item.filePath);
    flushed += 1;
  }
  return { queued_before: queued.length, flushed };
}

export async function flushInjectionEventOutbox(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const queued = listInjectionEventOutbox(resolveDataDir(runtimeEnv));
  let flushed = 0;
  for (const item of queued) {
    await submitInjectionEvent(item.resume_id, item.payload, runtimeEnv);
    removeOutboxItem(item.filePath);
    flushed += 1;
  }
  return { queued_before: queued.length, flushed };
}

export async function flushOutbox(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const dataDir = resolveDataDir(runtimeEnv);
  const queued = listOutbox(dataDir);
  let flushed = 0;
  let quarantined = 0;
  for (const item of queued) {
    try {
      await remoteRequest(runtimeEnv, "POST", "/v1/events", item.payload);
      removeOutboxItem(item.filePath);
      flushed += 1;
    } catch (error) {
      if (error.statusCode !== 413) throw error;
      quarantineOutboxItem(dataDir, item.filePath, error);
      quarantined += 1;
    }
  }
  return { queued_before: queued.length, flushed, quarantined };
}
