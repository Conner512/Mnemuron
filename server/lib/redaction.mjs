// Write-time secret scrubbing. Every memory and captured event is readable by connected agents (including ChatGPT),
// so credentials are replaced before anything is stored, indexed, embedded or hashed. Only well-known credential shapes
// and explicit `<private>` spans are touched; ordinary prose, identifiers and placeholders are left exactly as written.
const MARK = kind => `[REDACTED:${kind}]`;
const PLACEHOLDER = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\*+|x{4,}|\.{3,}|(?:your|my|example|sample|dummy|changeme|placeholder)[-_a-z0-9]*|\[REDACTED(?::[a-z_]+)?\])$/i;
// A key names a credential only when it ends with a credential word: github_token, apiKey, client_secret — but not
// credential_id, max_tokens, author or tokenizer.
const SENSITIVE_NAME = /(?:^|_)(?:api_?key|secret|token|password|passwd|pwd|private_key|access_key|authorization|credentials?)$/;
const sensitiveName = key => SENSITIVE_NAME.test(String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_').toLowerCase());
// A credential value has a letter in it; pure numbers (limits, counts) are left alone.
const secretValue = value => !PLACEHOLDER.test(value) && !value.startsWith('[REDACTED') && /[A-Za-z]/.test(value);

// Ordered: block-level spans first, then exact credential formats, then generic `NAME=value` assignments.
const RULES = [
  ['private', /<private>[\s\S]*?<\/private>/gi, () => MARK('private')],
  ['private_key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, () => MARK('private_key')],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai_key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['stripe_key', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer', /(\b(?:bearer|basic)\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi, (m, prefix, value) => PLACEHOLDER.test(value) ? m : prefix + MARK('bearer')],
  ['url_password', /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi, (m, head, value, at) => PLACEHOLDER.test(value) ? m : head + MARK('url_password') + at],
  // NAME=value / NAME: value / "name": "value" where the name says it is a credential.
  ['assignment', /(["']?\b[A-Za-z0-9_.-]*(?:api[-_]?key|apikey|secret|token|passw(?:or)?d|passwd|private[-_]?key|access[-_]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=!@#$%^&*-]{8,})/gi,
    (m, head, value) => secretValue(value) ? head + MARK('assignment') : m],
];

/** Scrub one string. Returns {text, count, kinds}; text is unchanged (same string) when nothing matched. */
export function redactText(input) {
  if (typeof input !== 'string' || !input) return { text: input, count: 0, kinds: [] };
  let text = input, count = 0;
  const kinds = new Set();
  for (const [kind, pattern, replace = () => MARK(kind)] of RULES) {
    text = text.replace(pattern, (...args) => {
      const out = replace(...args);
      if (out !== args[0]) { count += 1; kinds.add(kind); }
      return out;
    });
  }
  return { text, count, kinds: [...kinds] };
}

/** Deep-scrub JSON-like values. A string under a credential-named key is replaced whole. Input is never mutated. */
export function redactValue(value, key = '') {
  if (typeof value === 'string') {
    if (key && sensitiveName(key) && value.length >= 6 && !/\s/.test(value.trim()) && secretValue(value)) {
      return { value: MARK('field'), count: 1, kinds: ['field'] };
    }
    const { text, count, kinds } = redactText(value);
    return { value: text, count, kinds };
  }
  if (!value || typeof value !== 'object') return { value, count: 0, kinds: [] };
  let count = 0;
  const kinds = new Set();
  const take = (item, name) => { const r = redactValue(item, name); count += r.count; r.kinds.forEach(k => kinds.add(k)); return r.value; };
  const out = Array.isArray(value) ? value.map(item => take(item, key)) : Object.fromEntries(Object.entries(value).map(([name, item]) => [name, take(item, name)]));
  return count ? { value: out, count, kinds: [...kinds] } : { value, count: 0, kinds: [] };
}

/** Scrub the named text fields of a write payload; other fields (IDs, scopes, types) are never touched. */
export function redactFields(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { value: payload, count: 0, kinds: [], fields: [] };
  let count = 0, next = payload;
  const kinds = new Set(), changed = [];
  for (const field of fields) {
    if (typeof payload[field] !== 'string') continue;
    const r = redactText(payload[field]);
    if (!r.count) continue;
    if (next === payload) next = { ...payload };
    next[field] = r.text; count += r.count; changed.push(field); r.kinds.forEach(k => kinds.add(k));
  }
  return { value: next, count, kinds: [...kinds], fields: changed };
}
