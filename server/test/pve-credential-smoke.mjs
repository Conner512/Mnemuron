#!/usr/bin/env node

import { readFileSync } from "node:fs";

const serverUrl = process.env.MNEMURON_SERVER_URL || "http://127.0.0.1:47831";
const apiKeyFile = process.env.MNEMURON_API_KEY_FILE;
if (!apiKeyFile) throw new Error("MNEMURON_API_KEY_FILE is required.");
const expectedDeviceId = process.env.MNEMURON_EXPECTED_DEVICE_ID;
const expectedInstanceId = process.env.MNEMURON_EXPECTED_INSTANCE_ID;
if (!expectedDeviceId || !expectedInstanceId) {
  throw new Error("MNEMURON_EXPECTED_DEVICE_ID and MNEMURON_EXPECTED_INSTANCE_ID are required.");
}
const apiKey = readFileSync(apiKeyFile, "utf8").trim();

async function request(endpoint, body) {
  const response = await fetch(new URL(endpoint, serverUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const preview = await request("/v1/resume/preview", {
  query: "继续 Mnemuron plugin 任务",
});
if (preview.status !== "pending_confirmation" || preview.requires_confirmation !== true) {
  throw new Error("Preview confirmation gate is missing.");
}
if (Object.hasOwn(preview, "resume_packet")) {
  throw new Error("Resume Packet was returned before confirmation.");
}
const sourceActivity = preview.recent_activity.find((activity) =>
  activity.provenance?.device_id === expectedDeviceId &&
  activity.provenance?.agent_instance_id === expectedInstanceId
);
if (!sourceActivity) throw new Error("Expected device provenance was not found in the preview.");

const confirmed = await request(`/v1/resume/${encodeURIComponent(preview.resume_id)}/confirm`, {
  preview_version: preview.preview_version,
  confirmed: true,
});
if (confirmed.status !== "confirmed" || !confirmed.resume_packet) {
  throw new Error("Resume Packet was not returned after confirmation.");
}

process.stdout.write(`${JSON.stringify({
  preview_status: preview.status,
  preview_version: preview.preview_version,
  packet_before_confirmation: false,
  confirmed_status: confirmed.status,
  same_resume_id: confirmed.resume_packet.resume_id === preview.resume_id,
  source: sourceActivity.provenance,
}, null, 2)}\n`);
