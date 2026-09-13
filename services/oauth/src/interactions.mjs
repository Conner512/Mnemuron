import { BoundaryError, parseForm, readBody, seconds } from "../../../shared/oauth-common.mjs";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

function page(response, body, redirectUri) {
  // no-referrer also suppresses Origin on native form POSTs, breaking the same-origin boundary.
  // Form navigation policies also cover the final redirect to the registered OAuth callback.
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; form-action 'self' ${redirectUri}; frame-ancestors 'none'; base-uri 'none'`,
    "x-frame-options": "DENY", "referrer-policy": "same-origin", "x-content-type-options": "nosniff" });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mnemuron authorization</title><main><h1>Mnemuron</h1>${body}</main></html>`);
}

export async function interactionRequest(request, response, { provider, store, accounts, config, url }) {
  const match = url.pathname.match(/^\/interaction\/([A-Za-z0-9_-]{1,128})(?:\/(login|confirm|abort))?$/);
  if (!match) throw new BoundaryError(404, "NOT_FOUND");
  const details = await provider.interactionDetails(request, response);
  if (details.uid !== match[1] || details.params.client_id !== config.chatgpt_client.client_id
    || !config.chatgpt_client.redirect_uris.includes(details.params.redirect_uri)) {
    throw new BoundaryError(403, "INTERACTION_MISMATCH");
  }
  const { uid, prompt, params } = details;
  if (request.method === "GET" && !match[2]) {
    const csrf = store.csrf(uid, Math.min(details.exp - seconds(), config.token_policy.interaction_ttl_seconds));
    const field = `<input type="hidden" name="csrf" value="${csrf}">`;
    const abort = `<form method="post" action="/interaction/${uid}/abort">${field}<button type="submit">Cancel</button></form>`;
    if (prompt.name === "login") {
      return page(response, `<h2>Sign in to your Mnemuron account</h2><p>Do not enter your ChatGPT password here.</p>
        <form method="post" action="/interaction/${uid}/login">${field}
        <p><label>Username <input name="username" autocomplete="username" maxlength="100" required></label></p>
        <p><label>Password <input type="password" name="password" autocomplete="current-password" maxlength="1024" required></label></p>
        <p><label>Authenticator code <input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label></p>
        <button type="submit">Sign in</button></form>${abort}`, params.redirect_uri);
    }
    if (prompt.name === "consent") {
      const scopes = String(params.scope || "").split(" ");
      const labels = { openid: "Identify your Mnemuron account", offline_access: "Keep this connection with revocable, rotating refresh tokens",
        "memory:read": "Read memories you are authorized to access", "project:read": "Read context from your projects" };
      const list = scopes.filter((scope) => labels[scope]).map((scope) => `<li>${escapeHtml(labels[scope])}</li>`).join("");
      return page(response, `<h2>Allow ${escapeHtml(config.chatgpt_client.client_id)}?</h2><ul>${list}</ul>
        <p>This is read-only access to this owner's authorized data, not access restricted to one project. No memory writes, task switching or Resume confirmation.</p>
        <form method="post" action="/interaction/${uid}/confirm">${field}<button type="submit">Allow read-only access</button></form>${abort}`, params.redirect_uri);
    }
    throw new BoundaryError(400, "UNSUPPORTED_INTERACTION");
  }
  if (request.method !== "POST" || !match[2]) throw new BoundaryError(405, "METHOD_NOT_ALLOWED");
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers["content-type"] || "")) {
    throw new BoundaryError(415, "FORM_REQUIRED");
  }
  const body = parseForm(await readBody(request, config.limits.request_body_bytes));
  if (!body.get("csrf") || !store.consumeCsrf(uid, body.get("csrf"))) throw new BoundaryError(403, "CSRF_REJECTED");
  if (match[2] === "abort") {
    return provider.interactionFinished(request, response, { error: "access_denied", error_description: "The user denied authorization" }, { mergeWithLastSubmission: false });
  }
  if (match[2] === "login" && prompt.name === "login") {
    store.limit("login:owner", config.limits.login_attempts_per_account_per_15min, 900);
    store.limit(`login:peer:${request.socket.remoteAddress}`, config.limits.login_attempts_per_account_per_15min, 900);
    const subject = await accounts.authenticate(body.get("username"), body.get("password"), body.get("otp"));
    if (!subject) throw new BoundaryError(401, "LOGIN_FAILED");
    return provider.interactionFinished(request, response,
      { login: { accountId: subject, acr: "urn:mnemuron:password-totp", amr: ["pwd", "otp"], ts: seconds() } },
      { mergeWithLastSubmission: false });
  }
  if (match[2] === "confirm" && prompt.name === "consent") {
    const subject = details.session?.accountId;
    if (!accounts.eligible(subject)) throw new BoundaryError(403, "ACCOUNT_DISABLED");
    let grant = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
    grant ||= new provider.Grant({ accountId: subject, clientId: params.client_id });
    if (prompt.details.missingOIDCScope) grant.addOIDCScope(prompt.details.missingOIDCScope.join(" "));
    for (const [resource, scopes] of Object.entries(prompt.details.missingResourceScopes || {})) {
      if (resource !== config.resource) throw new BoundaryError(400, "INVALID_RESOURCE");
      grant.addResourceScope(resource, scopes.join(" "));
    }
    const remaining = grant.exp ? grant.exp - seconds() : config.token_policy.refresh_absolute_ttl_seconds;
    if (remaining <= 0) throw new BoundaryError(400, "GRANT_EXPIRED");
    const grantId = await grant.save(remaining);
    return provider.interactionFinished(request, response, { consent: { grantId } }, { mergeWithLastSubmission: true });
  }
  throw new BoundaryError(400, "INTERACTION_MISMATCH");
}
