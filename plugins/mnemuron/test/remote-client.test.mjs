import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { flushOutbox } from "../scripts/remote-client.mjs";
import {
  enqueueOutbox,
  listOutbox,
  listOutboxQuarantine,
} from "../scripts/storage.mjs";

test("ChatGPT outbox quarantines a permanent 413 and continues later events", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-chatgpt-quarantine-"));
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      if (envelope.event.event_id === "event-413-a") {
        response.statusCode = 413;
        response.end(JSON.stringify({ error: "Request body is too large." }));
        return;
      }
      received.push(envelope.event.event_id);
      response.statusCode = 202;
      response.end(JSON.stringify({ status: "accepted", received: 1, inserted: 1, duplicate: 0 }));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    const env = {
      HOME: dataDir,
      MNEMURON_SPIKE_DATA_DIR: dataDir,
      MNEMURON_SERVER_URL: `http://127.0.0.1:${port}`,
      MNEMURON_ALLOW_INSECURE_HTTP: "true",
      MNEMURON_API_KEY: "mnm_test-quarantine",
      MNEMURON_REQUEST_TIMEOUT_MS: "1000",
    };
    enqueueOutbox(dataDir, {
      event: { event_id: "event-413-a", session_id: "lane-bad" },
      raw_retention_days: 1,
    });
    enqueueOutbox(dataDir, {
      event: { event_id: "event-valid-z", session_id: "lane-good" },
      raw_retention_days: 1,
    });

    assert.deepEqual(await flushOutbox(env), {
      queued_before: 2,
      flushed: 1,
      quarantined: 1,
      blocked: 0,
    });
    assert.deepEqual(received, ["event-valid-z"]);
    assert.equal(listOutbox(dataDir).length, 0);
    const [terminal] = listOutboxQuarantine(dataDir);
    assert.equal(terminal.event_id, "event-413-a");
    assert.equal(terminal.reason, "permanent_http_413");
    assert.equal(terminal.http_status, 413);
    const quarantineDir = path.join(dataDir, "outbox-quarantine");
    assert.equal(statSync(quarantineDir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(quarantineDir, "event-413-a.json")).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(quarantineDir, "event-413-a.json"), "utf8")),
      { event: { event_id: "event-413-a", session_id: "lane-bad" }, raw_retention_days: 1 },
    );
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
