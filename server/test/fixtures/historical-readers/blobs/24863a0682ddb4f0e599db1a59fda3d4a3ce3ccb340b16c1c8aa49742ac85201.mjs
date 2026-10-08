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
  // A bare relative path needs a file extension: namespace tags such as AgentMemory/observation/Mnemuron
  // are not shown as if they were files.
  return parts.length >= 2 && /\.[A-Za-z0-9]{1,10}$/.test(text);
}

export function splitLeadingPath(content) {
  const text = String(content ?? '');
  const wrapped = text.match(WRAPPED);
  const match = wrapped ? [wrapped[0], wrapped[1] ?? wrapped[2]] : text.match(BARE);
  if (!match || !looksLikePath(match[1])) return null;
  const body = text.slice(match[0].length).trim();
  return body ? { path: match[1], body } : null;
}

// Display-only presentation of a memory: a short title, plus any imported namespace-style topic kept apart as
// a tag. Nothing is stored or rewritten; title is derived from the stored topic or content on every read.
const TITLE_MAX = 28, LATIN_TITLE_MAX = 56, TOPIC_TITLE_MAX = 40;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
/** Identifier segments joined by / \ : . _ - with no spaces or CJK: an import namespace, not a title. */
export const isNamespaceTag = value => /^[A-Za-z0-9][A-Za-z0-9_.:@-]*(?:[\/\\][A-Za-z0-9_.:@-]+)*$/.test(String(value ?? '').trim());
const graphemes = value => [...String(value)];
function clip(value, max) {
  const chars = graphemes(value);
  if (chars.length <= max) return chars.join('');
  let cut = chars.slice(0, max - 1).join('');
  // Latin text breaks at a word boundary when one is reasonably close.
  const space = cut.lastIndexOf(' ');
  if (!CJK.test(cut) && space > max / 2) cut = cut.slice(0, space);
  return cut.trimEnd().replace(/[,，、:：;；]$/u, '') + '…';
}
function contentTitle(content) {
  const parts = splitLeadingPath(content);
  let text = String(parts ? parts.body : content ?? '');
  text = text.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, '');
  // A leading namespace label ("AgentMemory/observation: ...") is not the subject of the memory.
  const label = text.match(/^\s*([^\s:：]+)\s*[:：]\s*(?=\S)/);
  if (label && isNamespaceTag(label[1]) && (label[1].split(/[\/\\]/).length >= 3 || label[1].includes('/') && /[A-Z]/.test(label[1]))) text = text.slice(label[0].length);
  const line = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  const sentence = line.match(/^.+?(?:[。！？；]|[.!?;](?=\s|$))/u)?.[0] || line;
  const title = sentence.replace(/[*_`]+/g, '').replace(/[。．.;；:：,，、\s]+$/u, '').trim();
  return clip(title, CJK.test(title) ? TITLE_MAX : LATIN_TITLE_MAX);
}
export function memoryPresentation({content, topic, memory_id} = {}) {
  const raw = typeof topic === 'string' ? topic.trim() : '';
  const usable = raw && !isNamespaceTag(raw) && graphemes(raw).length <= TOPIC_TITLE_MAX && (CJK.test(raw) || /\s/.test(raw));
  if (usable) return {title: raw, title_source: 'topic'};
  const derived = contentTitle(content);
  return {title: derived || String(memory_id ?? ''), title_source: derived ? 'content' : 'id', ...(raw ? {tag: raw} : {})};
}
