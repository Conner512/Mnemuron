export function readRemoteDeploymentConfig(values = {}) {
  const sshHost = values.sshHost || process.env.MNEMURON_PVE_HOST;
  const ctid = values.ctid || process.env.MNEMURON_CTID;
  const serverUrl = values.serverUrl || process.env.MNEMURON_SERVER_URL;
  for (const [name, value] of Object.entries({
    MNEMURON_PVE_HOST: sshHost,
    MNEMURON_CTID: ctid,
    MNEMURON_SERVER_URL: serverUrl,
  })) {
    if (!value) throw new Error(`${name} is required; set an explicit deployment target before running.`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/u.test(sshHost)) {
    throw new Error("The PVE SSH host must be an explicit hostname, address, or SSH alias.");
  }
  if (!/^[1-9][0-9]*$/u.test(String(ctid)) || !Number.isSafeInteger(Number(ctid))) {
    throw new Error("The container ID must be a positive integer.");
  }
  const url = new URL(serverUrl);
  if (url.protocol !== "https:" || url.username || url.password ||
      /(^|\.)(example\.(com|net|org)|invalid|example)$/iu.test(url.hostname)) {
    throw new Error("The server URL must be an explicit HTTPS deployment URL without embedded credentials or example domains.");
  }
  return { sshHost, ctid: Number(ctid), serverUrl: url.toString() };
}
