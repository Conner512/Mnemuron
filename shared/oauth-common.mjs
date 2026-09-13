import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const RESOURCE_SCOPES = Object.freeze(["memory:read", "project:read"]);
export const OAUTH_SCOPES = Object.freeze(["openid", "offline_access", ...RESOURCE_SCOPES]);
export const CORE_SCOPES = Object.freeze(["memory:read", "resume:read"]);
export const secretHash = (value) => createHash("sha256").update(value).digest("hex");
export const randomSecret = () => randomBytes(32).toString("base64url");
export const seconds = () => Math.floor(Date.now() / 1000);
export const equalSecret = (left, right) => timingSafeEqual(
  createHash("sha256").update(String(left)).digest(),
  createHash("sha256").update(String(right)).digest(),
);

export class BoundaryError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function requireConfig(condition, field) {
  if (!condition) throw new Error(`Invalid OAuth configuration: ${field}`);
}

export function boundedInteger(value, fallback, min, max, field) {
  const result = value ?? fallback;
  requireConfig(Number.isInteger(result) && result >= min && result <= max, field);
  return result;
}

export function exactList(actual, expected, field) {
  requireConfig(Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === actual.length && actual.every((item) => expected.includes(item)), field);
}

export function publicOriginMode(config) {
  const mode = config.public_origin_mode ?? "separate";
  requireConfig(["separate", "shared"].includes(mode), "public_origin_mode");
  requireConfig((config.issuer === new URL(config.resource).origin) === (mode === "shared"), "public origin mode must match issuer/resource");
  return mode;
}

export function canonicalUrl(value, { isolated = false, pathname, loopbackHttp = false } = {}) {
  requireConfig(typeof value === "string" && value.length < 2048 && !/[{}*\s]|__REQUIRED/i.test(value), "URL");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid OAuth configuration: URL"); }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  requireConfig(!url.username && !url.password && !url.search && !url.hash, "URL components");
  requireConfig(url.href === value || (url.pathname === "/" && url.origin === value), "canonical URL spelling");
  requireConfig(!value.endsWith("/"), "URL trailing slash");
  if (isolated) requireConfig(loopback && url.protocol === "http:", "isolated fixtures must use literal HTTP loopback");
  else {
    requireConfig(url.protocol === "https:" || (loopbackHttp && loopback && url.protocol === "http:"), "HTTPS");
    requireConfig(!/(^|\.)(example\.(com|net|org)|localhost|test|invalid)$/.test(url.hostname), "real deployment hostname");
    if (!loopbackHttp) requireConfig(!isIP(url.hostname.replace(/[\[\]]/g, "")) && url.hostname.includes(".")
      && !/(^|\.)(example|local)$/.test(url.hostname), "public deployment hostname");
  }
  if (pathname !== undefined) requireConfig(url.pathname === pathname, "URL path");
  return url;
}

export function privateDirectory(directory, { create = false } = {}) {
  requireConfig(path.isAbsolute(directory), "absolute private directory");
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  requireConfig(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (process.getuid === undefined || stat.uid === process.getuid()), "private directory permissions/owner");
}

export function readPrivate(file, { json = false } = {}) {
  requireConfig(typeof file === "string" && path.isAbsolute(file), "absolute secret file");
  privateDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    requireConfig(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= 128 * 1024
      && (process.getuid === undefined || stat.uid === process.getuid()), "secret file permissions/size/owner");
    const value = fs.readFileSync(fd, "utf8").trim();
    return json ? JSON.parse(value) : value;
  } finally { fs.closeSync(fd); }
}

export function writePrivate(file, value, { replace = false } = {}) {
  privateDirectory(path.dirname(file), { create: true });
  const data = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `${data}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (replace) {
      readPrivate(file);
      fs.renameSync(temporary, file);
    } else {
      fs.linkSync(temporary, file);
      fs.unlinkSync(temporary);
    }
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function readSecret(file) {
  const value = readPrivate(file);
  requireConfig(/^[A-Za-z0-9_-]{43,256}$/.test(value), "random secret format (at least 32 bytes)");
  return value;
}

export function requestBoundary(request, canonical, { isolated = false, allowedOrigins = [] } = {}) {
  if (request.url.length > 8192) throw new BoundaryError(414, "REQUEST_URI_TOO_LARGE");
  const url = new URL(request.url, canonical.origin);
  if (!request.url.startsWith("/") || request.url.startsWith("//")
    || request.headers.host !== canonical.host || url.origin !== canonical.origin) {
    throw new BoundaryError(400, "INVALID_HOST");
  }
  if (request.headers.origin && ![canonical.origin, ...allowedOrigins].includes(request.headers.origin)) {
    throw new BoundaryError(403, "ORIGIN_DENIED");
  }
  const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
  if (["authorization", "host", "origin", "content-type"].some((name) => names.filter((item) => item === name).length > 1)) {
    throw new BoundaryError(400, "AMBIGUOUS_HEADERS");
  }
  if (url.searchParams.has("access_token")) throw new BoundaryError(400, "URL_TOKEN_FORBIDDEN");
  // The only trusted proxy is the local origin connection. Never use caller-supplied forwarding headers.
  for (const name of Object.keys(request.headers)) {
    if (name === "forwarded" || name.startsWith("x-forwarded-") || name === "cf-connecting-ip") delete request.headers[name];
  }
  if (!isolated) {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) {
      throw new BoundaryError(403, "UNTRUSTED_PROXY");
    }
    request.headers["x-forwarded-proto"] = "https";
  }
  return url;
}

export function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text),
    "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers,
  });
  response.end(text);
}

export async function readBody(request, maxBytes = 65536) {
  if (Number(request.headers["content-length"] || 0) > maxBytes) throw new BoundaryError(413, "REQUEST_TOO_LARGE");
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw new BoundaryError(413, "REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseForm(text) {
  const params = new URLSearchParams(text);
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1) throw new BoundaryError(400, "AMBIGUOUS_PARAMETERS");
  }
  return params;
}

export async function fetchJson(url, options = {}, { timeoutMs = 5000, maxBytes = 65536 } = {}) {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!/^application\/json\b/i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel();
    throw new Error("Invalid dependency response");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("Dependency response limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}

export class SerialGate {
  tail = Promise.resolve();
  count = 0;
  async run(callback) {
    if (this.count >= 32) throw new BoundaryError(429, "BUSY");
    this.count += 1;
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await callback(); } finally { this.count -= 1; release(); }
  }
}

export class WindowLimit {
  entries = new Map();
  take(key, limit, windowMs = 60000) {
    const now = Date.now();
    for (const [item, value] of this.entries) if (value.until <= now) this.entries.delete(item);
    if (!this.entries.has(key)) {
      if (this.entries.size >= 1024) throw new BoundaryError(429, "RATE_LIMITED");
      this.entries.set(key, { until: now + windowMs, used: 0 });
    }
    const entry = this.entries.get(key);
    if (++entry.used > limit) throw new BoundaryError(429, "RATE_LIMITED");
  }
}
