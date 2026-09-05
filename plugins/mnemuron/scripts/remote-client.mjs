import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from 'node:path';
import { RESPONSE_LIMIT, decodeResponse, protocolError, flushQueue, queueItems, queueSummary, validateAcceptance } from './sync-protocol.mjs';
import {
  loadRuntimeEnv,
  markMcpDeliveryAcknowledgementReported,
  quarantineOutboxItem,
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
  if (target.origin !== settings.baseUrl.origin) throw protocolError('REDIRECT_BLOCKED');
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled=false;
    const done=(error,data)=>{if(settled)return;settled=true;clearTimeout(deadline);error?reject(error):resolve(data);};
    const deadline=setTimeout(()=>request.destroy(protocolError('TOTAL_TIMEOUT')),settings.timeoutMs);
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
      let bytes=0;
      response.on("data", (chunk) => {bytes+=chunk.length;if(bytes>RESPONSE_LIMIT){request.destroy(protocolError('RESPONSE_TOO_LARGE',response.statusCode));return;} chunks.push(chunk);});
      response.on('error',error=>done(error));
      response.on("end", () => {
        try {
          done(null,decodeResponse(response.statusCode,Buffer.concat(chunks).toString('utf8'),response.headers['retry-after']));
        } catch(error) {done(error);}
      });
    });
    request.on("timeout", () => request.destroy(protocolError('TOTAL_TIMEOUT')));
    request.on("error", error=>done(error));
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

export async function rememberRemote(env, body) {
  const operationId = body.operation_id === undefined ? randomUUID() : body.operation_id;
  if (typeof operationId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId)) {
    throw new Error("operation_id must be a non-empty ASCII identifier of at most 128 characters.");
  }
  const payload = { ...body, operation_id: operationId };
  try {
    return await remoteRequest(env, "POST", "/v1/memories", payload);
  } catch (error) {
    throw Object.assign(new Error(
      `Memory save not confirmed; retry the same payload with operation_id=${operationId}. ${error.message}`,
      { cause: error },
    ), { operation_id: operationId, statusCode: error.statusCode, responseData: error.responseData });
  }
}

export function submitEvent(event, env = process.env) {
  return remoteRequest(env, "POST", "/v1/events", eventEnvelope(event, env));
}

export async function submitInjectionEvent(resumeId, payload, env = process.env) {
  const result=await remoteRequest(
    env,
    "POST",
    `/v1/resume/${encodeURIComponent(resumeId)}/injection-events`,
    payload,
  );
  validateAcceptance('injection',{resume_id:resumeId,payload},result);
  return result;
}

export async function submitDeliveryReceipt(resumeId, payload, env = process.env) {
  const result=await remoteRequest(
    env,
    "POST",
    `/v1/resume/${encodeURIComponent(resumeId)}/delivery-receipts`,
    payload,
  );
  if(payload.phase!=='delivered')validateAcceptance('receipt',{resume_id:resumeId,payload},result);
  return result;
}

export async function flushDeliveryReceiptOutbox(env = process.env) {
  return flushKind('receipt',env);
}

export async function flushInjectionEventOutbox(env = process.env) {
  return flushKind('injection',env);
}

export async function flushOutbox(env = process.env) {
  return flushKind('event',env);
}

const queueDirectories={event:'outbox',injection:'injection-event-outbox',receipt:'delivery-receipt-outbox'};
export function localSyncSummary(env=process.env) {
  const root=resolveDataDir(loadRuntimeEnv(env));
  return queueSummary(Object.entries(queueDirectories).flatMap(([kind,dir])=>queueItems(path.join(root,dir),kind)),Date.now(),root);
}
async function flushKind(kind,env) {
  const runtimeEnv=loadRuntimeEnv(env),root=resolveDataDir(runtimeEnv);
  return flushQueue(queueItems(path.join(root,queueDirectories[kind]),kind),{
    root,credential:runtimeEnv.MNEMURON_SERVER_URL+'|'+resolveApiKey(runtimeEnv),
    predecessors:Object.entries(queueDirectories).filter(([other])=>other!==kind).flatMap(([other,dir])=>queueItems(path.join(root,dir),other)),
    send:item=>kind==='event'?remoteRequest(runtimeEnv,'POST','/v1/events',item.payload):kind==='injection'?submitInjectionEvent(item.resume_id,item.payload,runtimeEnv):submitDeliveryReceipt(item.resume_id,item.payload,runtimeEnv),
    quarantine:kind==='event'?(item,error)=>quarantineOutboxItem(root,item.filePath,error):null,
    accepted:item=>{if(kind==='receipt'&&item.payload.phase==='acknowledged')markMcpDeliveryAcknowledgementReported(root,item.payload.receipt_event_id);},
  });
}
