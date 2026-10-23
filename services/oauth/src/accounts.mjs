import { promisify } from "node:util";
import { scrypt, randomBytes, randomUUID } from "node:crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { readPrivate, writePrivate, requireConfig, equalSecret, randomSecret, secretHash } from "../../../shared/oauth-common.mjs";

const derive = promisify(scrypt);
const SCRYPT = Object.freeze({ N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

export async function createOwner(file, username, password) {
  requireConfig(typeof username === "string" && /^[A-Za-z0-9_.@-]{1,100}$/.test(username), "owner name");
  requireConfig(typeof password === "string" && password.length >= 14 && password.length <= 1024, "password length (14..1024)");
  const salt = randomBytes(32).toString("base64url");
  const hash = (await derive(password, salt, 64, SCRYPT)).toString("base64url");
  const owner = { subject: randomUUID(), username, enabled: true, password: { algorithm: "scrypt", salt, hash, N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    mfa: { secret: generateSecret(), verified: false }, recovery_hashes: [] };
  writePrivate(file, owner);
  return { subject: owner.subject, mfa_verified: false };
}

export class Accounts {
  constructor(file, store) { this.file = file; this.store = store; }
  read({ requireMfa = true } = {}) {
    const owner = readPrivate(this.file, { json: true });
    requireConfig(typeof owner.subject === "string" && owner.subject.length >= 16
      && owner.password?.algorithm === "scrypt" && owner.password.N === SCRYPT.N
      && owner.password.r === SCRYPT.r && owner.password.p === SCRYPT.p
      && typeof owner.password.salt === "string" && typeof owner.password.hash === "string"
      && typeof owner.mfa?.secret === "string" && typeof owner.enabled === "boolean", "owner account");
    requireConfig(!requireMfa || owner.mfa.verified === true, "verified MFA required");
    return owner;
  }
  eligible(subject) {
    const owner = this.read();
    return owner.enabled && owner.subject === subject;
  }
  async authenticate(username, password, otp) {
    const owner = this.read();
    const supplied = typeof password === "string" && password.length <= 1024 ? password : "";
    const derived = (await derive(supplied, owner.password.salt, 64, SCRYPT)).toString("base64url");
    if (!equalSecret(derived, owner.password.hash) || !equalSecret(username || "", owner.username)
      || !owner.enabled || !/^\d{6}$/.test(otp || "")) return null;
    const result = await verify({ secret: owner.mfa.secret, token: otp, epochTolerance: 30 });
    if (!result.valid || !this.store.consumeStep(owner.subject, result.epoch)) return null;
    // Disable/reset may race the asynchronous password check. Re-read the protected account before granting login.
    const current = this.read();
    if (!current.enabled || !equalSecret(current.password.hash, owner.password.hash)
      || !equalSecret(current.mfa.secret, owner.mfa.secret)) return null;
    return owner.subject;
  }
  enrollmentUri() {
    const owner = this.read({ requireMfa: false });
    requireConfig(!owner.mfa.verified, "MFA already enrolled; use controlled reset");
    return generateURI({ issuer: "Mnemuron", label: owner.username, secret: owner.mfa.secret });
  }
  async enroll(otp, recoveryFile) {
    const owner = this.read({ requireMfa: false });
    requireConfig(!owner.mfa.verified, "MFA already enrolled");
    const result = await verify({ secret: owner.mfa.secret, token: otp, epochTolerance: 30 });
    requireConfig(result.valid && this.store.consumeStep(owner.subject, result.epoch), "MFA verification");
    const codes = Array.from({ length: 8 }, randomSecret);
    writePrivate(recoveryFile, codes);
    owner.mfa.verified = true;
    owner.recovery_hashes = codes.map(secretHash);
    writePrivate(this.file, owner, { replace: true });
  }
  disable() {
    const owner = this.read({ requireMfa: false });
    owner.enabled = false;
    writePrivate(this.file, owner, { replace: true });
    return this.store.revoke({ subject: owner.subject });
  }
  resetMfa(recoveryCode) {
    const owner = this.read();
    const digest = secretHash(recoveryCode);
    requireConfig(owner.recovery_hashes.some((item) => equalSecret(item, digest)), "invalid recovery code");
    owner.recovery_hashes = owner.recovery_hashes.filter((item) => !equalSecret(item, digest));
    owner.mfa = { secret: generateSecret(), verified: false };
    writePrivate(this.file, owner, { replace: true });
    const count = this.store.revoke({ subject: owner.subject });
    this.store.db.prepare("DELETE FROM oauth_mfa_steps WHERE subject=?").run(owner.subject);
    return count;
  }
}
