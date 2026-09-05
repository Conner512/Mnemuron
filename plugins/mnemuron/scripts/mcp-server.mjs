#!/usr/bin/env node

import readline from "node:readline";
import { callTool, PLUGIN_VERSION, TOOLS } from "./mcp-core.mjs";

const SERVER_INFO = {
  name: "mnemuron-spike",
  version: PLUGIN_VERSION,
};

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function toolResult(data, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

async function handle(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    throw Object.assign(new Error("Invalid JSON-RPC request."), { code: -32600 });
  }

  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    };
  }
  if (request.method === "ping") {
    return {};
  }
  if (request.method === "tools/list") {
    return { tools: TOOLS };
  }
  if (request.method === "tools/call") {
    try {
      const data = await callTool(
        request.params?.name,
        request.params?.arguments || {},
      );
      return toolResult(data);
    } catch (error) {
      return toolResult({ error: error.message }, true);
    }
  }
  throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  if (request.method?.startsWith("notifications/")) {
    return;
  }

  try {
    const result = await handle(request);
    if (request.id !== undefined) {
      send({ jsonrpc: "2.0", id: request.id, result });
    }
  } catch (error) {
    if (request.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: Number.isInteger(error.code) ? error.code : -32603,
          message: error.message,
        },
      });
    }
  }
});
