import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { privateDirectory, requireConfig, seconds, secretHash, randomSecret, BoundaryError } from "../../../shared/oauth-common.mjs";

export class AuthStore {
  constructor(file, { identity = false } = {}) {
    this.identityMode=identity;
    privateDirectory(path.dirname(file), { create: true });
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "wx", 0o600));
    const stat = fs.lstatSync(file);
    requireConfig(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
      && (!process.getuid || stat.uid === process.getuid()), "auth database permissions/owner");
    this.db = new DatabaseSync(file);
    try {
      const tables = new Set(["oauth_records", "oauth_revoked_grants", "oauth_mfa_steps", "oauth_rate_limits", "oauth_csrf"]);
      if (identity) for (const name of ['identity_accounts','identity_invitations','identity_sessions',
        'identity_bindings','identity_operations','identity_audit','identity_recovery_claims']) tables.add(name);
      const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      requireConfig(existing.every(row => tables.has(row.name)), "separate OAuth database; unknown business tables");
      this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS oauth_records (
        model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        expires INTEGER NOT NULL, grant_id TEXT, uid TEXT, user_code TEXT,
        PRIMARY KEY(model,id)
      );
      CREATE INDEX IF NOT EXISTS oauth_by_grant ON oauth_records(grant_id);
      CREATE INDEX IF NOT EXISTS oauth_by_uid ON oauth_records(model,uid);
      CREATE INDEX IF NOT EXISTS oauth_by_user_code ON oauth_records(model,user_code);
      CREATE TABLE IF NOT EXISTS oauth_revoked_grants (id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_mfa_steps (subject TEXT PRIMARY KEY, step INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_rate_limits (key TEXT PRIMARY KEY, until INTEGER NOT NULL, used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_csrf (uid TEXT PRIMARY KEY, digest TEXT NOT NULL, expires INTEGER NOT NULL);
      `);
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(callback) {
    this.assertCompatible();
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = callback(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  assertCompatible() {
    if(!this.identityMode&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_accounts'").get())
      throw new Error('Incompatible legacy writer: database is multi-account');
  }

  adapter() {
    const store = this;
    return class SQLiteAdapter {
      constructor(model) { this.model = model; }
      async upsert(id, payload, expiresIn) {
        store.transaction(() => {
          const grantId = this.model === "Grant" ? id : payload.grantId;
          if (grantId && store.db.prepare("SELECT 1 FROM oauth_revoked_grants WHERE id=?").get(grantId)) {
            throw new Error("Grant has been revoked");
          }
          const previous = store.db.prepare("SELECT payload FROM oauth_records WHERE model=? AND id=?").get(this.model, id);
          const consumed = previous && JSON.parse(previous.payload).consumed;
          const account = payload.accountId && store.identity?.account(payload.accountId);
          const data = {...payload,...(consumed?{consumed}:{}),...(account?{securityVersion:payload.securityVersion??account.security_version}:{})};
          store.db.prepare(`INSERT INTO oauth_records(model,id,payload,expires,grant_id,uid,user_code)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,
            expires=excluded.expires,grant_id=excluded.grant_id,uid=excluded.uid,user_code=excluded.user_code`)
            .run(this.model, id, JSON.stringify(data), seconds() + Math.max(0, Math.floor(expiresIn)),
              grantId || null, payload.uid || null, payload.userCode || null);
        });
      }
      async find(id) { return store.find(this.model, "id", id); }
      async findByUid(uid) { return store.find(this.model, "uid", uid); }
      async findByUserCode(code) { return store.find(this.model, "user_code", code); }
      async consume(id) {
        store.assertCompatible();
        const changed = store.db.prepare(`UPDATE oauth_records SET payload=json_set(payload,'$.consumed',?)
          WHERE model=? AND id=? AND expires>? AND json_extract(payload,'$.consumed') IS NULL`)
          .run(seconds(), this.model, id, seconds()).changes;
        if (changed !== 1) throw new Error("Authorization artifact already consumed or expired");
      }
      async destroy(id) {
        store.assertCompatible();
        if (this.model === "Grant") store.revokeGrant(id);
        else store.db.prepare("DELETE FROM oauth_records WHERE model=? AND id=?").run(this.model, id);
      }
      async revokeByGrantId(id) { store.revokeGrant(id); }
    };
  }

  find(model, field, value) {
    this.assertCompatible();
    if (!["id", "uid", "user_code"].includes(field)) throw new Error("Invalid index");
    const row = this.db.prepare(`SELECT payload FROM oauth_records AS r WHERE model=? AND ${field}=?
      AND expires>? AND NOT EXISTS(SELECT 1 FROM oauth_revoked_grants WHERE id=r.grant_id)`).get(model, value, seconds());
    if(!row)return undefined;
    const data=JSON.parse(row.payload);
    if(this.identity && data.accountId) {
      const account=this.identity.account(data.accountId);
      if(!this.identity.eligible(data.accountId)||data.securityVersion!==account?.security_version)return undefined;
    }
    return data;
  }

  revokeGrant(id) {
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO oauth_revoked_grants(id,revoked_at) VALUES(?,?)").run(id, seconds());
      this.db.prepare("DELETE FROM oauth_records WHERE grant_id=? OR (model='Grant' AND id=?)").run(id, id);
    });
  }

  revoke({ subject, clientId, all = false } = {}) {
    this.assertCompatible();
    if (!subject && !clientId && !all) throw new Error("A grant revocation selector is required");
    const rows = this.db.prepare("SELECT id,payload FROM oauth_records WHERE model='Grant'").all();
    let count = 0;
    for (const row of rows) {
      const grant = JSON.parse(row.payload);
      if (all || ((!subject || grant.accountId === subject) && (!clientId || grant.clientId === clientId))) {
        this.revokeGrant(row.id);
        count += 1;
      }
    }
    // Revoke only the selected subject/client, including unfinished interactions.
    const browser = this.db.prepare("SELECT model,id,payload FROM oauth_records WHERE model IN ('Session','Interaction')").all();
    for (const row of browser) {
      const data = JSON.parse(row.payload);
      const account = data.accountId || data.session?.accountId || data.result?.login?.accountId;
      const client = data.clientId || data.params?.client_id;
      if (all || ((!subject || account === subject) && (!clientId || client === clientId || data.authorizations?.[clientId]))) {
        this.db.prepare('DELETE FROM oauth_records WHERE model=? AND id=?').run(row.model,row.id);
        this.db.prepare('DELETE FROM oauth_csrf WHERE uid=?').run(data.uid || row.id);
      }
    }
    return count;
  }

  consumeStep(subject, epoch) {
    this.assertCompatible();
    const changed = this.db.prepare(`INSERT INTO oauth_mfa_steps(subject,step) VALUES(?,?)
      ON CONFLICT(subject) DO UPDATE SET step=excluded.step WHERE step<excluded.step`).run(subject, epoch).changes;
    return changed === 1;
  }

  limit(key, maximum, window = 60) {
    const now = seconds();
    const hashed = secretHash(key);
    this.transaction(() => {
      this.db.prepare("DELETE FROM oauth_rate_limits WHERE until<=?").run(now);
      const total = this.db.prepare("SELECT COUNT(*) AS n FROM oauth_rate_limits").get().n;
      if (total >= 1024 && !this.db.prepare("SELECT 1 FROM oauth_rate_limits WHERE key=?").get(hashed)) {
        throw new BoundaryError(429, "RATE_LIMITED");
      }
      this.db.prepare(`INSERT INTO oauth_rate_limits(key,until,used) VALUES(?,?,1)
        ON CONFLICT(key) DO UPDATE SET used=used+1`).run(hashed, now + window);
    });
    if (this.db.prepare("SELECT used FROM oauth_rate_limits WHERE key=?").get(hashed).used > maximum) {
      throw new BoundaryError(429, "RATE_LIMITED");
    }
  }

  csrf(uid, ttl) {
    this.assertCompatible();
    const token = randomSecret();
    this.db.prepare("INSERT OR REPLACE INTO oauth_csrf(uid,digest,expires) VALUES(?,?,?)")
      .run(uid, secretHash(token), seconds() + ttl);
    return token;
  }
  consumeCsrf(uid, token) {
    this.assertCompatible();
    return this.db.prepare("DELETE FROM oauth_csrf WHERE uid=? AND digest=? AND expires>?")
      .run(uid, secretHash(token), seconds()).changes === 1;
  }
  cleanup() {
    this.assertCompatible();
    this.db.prepare("DELETE FROM oauth_records WHERE expires<=?").run(seconds());
    this.db.prepare("DELETE FROM oauth_csrf WHERE expires<=?").run(seconds());
    this.db.prepare("DELETE FROM oauth_rate_limits WHERE until<=?").run(seconds());
    if(this.identityMode)this.db.prepare('DELETE FROM identity_sessions WHERE expires<=?').run(seconds());
    // Tombstones outlive the maximum grant/family lifetime, preventing delayed writes from reviving grants.
    this.db.prepare("DELETE FROM oauth_revoked_grants WHERE revoked_at<?").run(seconds() - 35 * 86400);
  }
  ready({ writeProbe = false } = {}) {
    try {
      if (this.db.prepare("PRAGMA quick_check(1)").get().quick_check !== "ok") return false;
      if (writeProbe) this.transaction(() => this.db.prepare(`INSERT INTO oauth_rate_limits(key,until,used) VALUES(?,?,0)
        ON CONFLICT(key) DO UPDATE SET until=excluded.until,used=0`).run(secretHash("health:write"), seconds() + 60));
      return true;
    } catch { return false; }
  }
  summary() {
    this.assertCompatible();
    return this.db.prepare("SELECT model,COUNT(*) AS count FROM oauth_records WHERE expires>? GROUP BY model").all(seconds());
  }
  close() { this.db.close(); }
}
