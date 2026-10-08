// Coarse, browser-reported client snapshot for a new Console sign-in (Console item 6). Only three normalized
// families are kept: device class, browser family and operating-system family. The raw User-Agent, versions,
// IP address and location are never stored or returned. Anything absent, oversized or unrecognized is 'unknown';
// the values are what the browser claimed at sign-in, not a verified physical device.
export const CLIENT_DEVICES=Object.freeze(['desktop','mobile','tablet','unknown']);
export const CLIENT_BROWSERS=Object.freeze(['edge','opera','samsung','firefox','chrome','safari','unknown']);
export const CLIENT_OSES=Object.freeze(['windows','ios','ipados','android','chromeos','macos','linux','unknown']);
export const CLIENT_UNKNOWN=Object.freeze({device:'unknown',browser:'unknown',os:'unknown'});
const MAX_USER_AGENT=512;

// First match wins; order matters (Edge, Opera and Samsung Internet also claim Chrome and Safari; Chrome on iOS claims Safari).
const BROWSERS=[['edge',/\bEdg(?:e|A|iOS)?\//],['opera',/\b(?:OPR|OPT|Opera)\//],['samsung',/\bSamsungBrowser\//],
  ['firefox',/\b(?:Firefox|FxiOS)\//],['chrome',/\b(?:CriOS|Chrome|Chromium)\//],['safari',/\bVersion\/[\d.]+.*\bSafari\//]];
// iPad before iPhone/Mac (an iPad in desktop mode reports macOS and stays macOS: the snapshot records the claim).
const OSES=[['windows',/\bWindows NT\b/],['ipados',/\biPad\b/],['ios',/\b(?:iPhone|iPod)\b/],['android',/\bAndroid\b/],
  ['chromeos',/\bCrOS\b/],['macos',/\bMac OS X\b|\bMacintosh\b/],['linux',/\bLinux\b/]];

export function clientSnapshot(userAgent){
  if(typeof userAgent!=='string'||!userAgent||userAgent.length>MAX_USER_AGENT||/[^\x20-\x7e]/.test(userAgent))return {...CLIENT_UNKNOWN};
  const browser=BROWSERS.find(([,re])=>re.test(userAgent))?.[0]??'unknown',os=OSES.find(([,re])=>re.test(userAgent))?.[0]??'unknown';
  const device=os==='ipados'||/\bTablet\b/.test(userAgent)||(os==='android'&&!/\bMobile\b/.test(userAgent))?'tablet'
    :os==='ios'||/\bMobi(?:le)?\b/.test(userAgent)?'mobile'
    :['windows','macos','linux','chromeos'].includes(os)?'desktop':'unknown';
  return {device,browser,os};
}

/** Stored values are re-validated on read; a malformed or missing row is reported as unknown, never guessed. */
export function storedClient(row){
  if(!row)return {...CLIENT_UNKNOWN,recorded:false};
  const ok=CLIENT_DEVICES.includes(row.device)&&CLIENT_BROWSERS.includes(row.browser)&&CLIENT_OSES.includes(row.os);
  return ok?{device:row.device,browser:row.browser,os:row.os,recorded:true}:{...CLIENT_UNKNOWN,recorded:false};
}
