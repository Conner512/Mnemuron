// Expire this browser's authorization session, not its grants or other devices.
export async function invalidateBrowserAuthorization(request,response,provider,{nextSubject}={}) {
  const session=await provider.Session.get(provider.createContext(request,response));
  if(!session.accountId || (nextSubject && session.accountId===nextSubject))return false;
  await session.destroy();
  return true;
}
