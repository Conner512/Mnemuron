// Display-only split of a leading file path from memory text. The stored content is never changed:
// `path` and `body` are verbatim slices of it, and anything that is not clearly a leading path
// (URLs, prose, a path with nothing after it) is left as one piece.
const LINE = '(?::\\d+(?::\\d+)?)?';
const BARE = new RegExp(`^((?:~|\\.{1,2})?\\/[^\\s:：\\]\`]+${LINE}|[A-Za-z]:\\\\[^\\s:：\\]\`]+${LINE}|[\\w.@-]+(?:\\/[\\w.@-]+)+${LINE})(?:[ \\t]*(?:[:：]|—|–| - )[ \\t]*|[ \\t]*\\r?\\n\\s*)`);
const WRAPPED = /^(?:\[([^\]\n]{1,512})\]|`([^`\n]{1,512})`)[ \t]*(?:[:：—–-][ \t]*)?(?:\r?\n\s*)?/;

function looksLikePath(value) {
  const text = value.replace(/:\d+(?::\d+)?$/, '');
  if (/\s/.test(text) || text.length > 512 || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  if (/^[A-Za-z]:\\/.test(text)) return text.split('\\').filter(Boolean).length >= 2;
  const parts = text.split('/').filter(Boolean);
  if (/^(?:~|\.{1,2})?\//.test(text)) return parts.length >= 2;
  return parts.length >= 2 && (/\.[A-Za-z0-9]{1,10}$/.test(text) || parts.length >= 3);
}

export function splitLeadingPath(content) {
  const text = String(content ?? '');
  const wrapped = text.match(WRAPPED);
  const match = wrapped ? [wrapped[0], wrapped[1] ?? wrapped[2]] : text.match(BARE);
  if (!match || !looksLikePath(match[1])) return null;
  const body = text.slice(match[0].length).trim();
  return body ? { path: match[1], body } : null;
}
