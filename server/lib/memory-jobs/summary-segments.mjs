import {fail} from '../model-providers/contracts.mjs';

export const SUMMARY_SEGMENTS = 'summary-segments-v1';
export const MAX_SUMMARY_SEGMENTS = 64;

/** Conservative boundaries, never a byte/character truncation. Fenced code and inline code stay atomic.
 * A paragraph without sentence punctuation can still end at a blank line. An unclosed fence stays atomic. */
export function summaryBoundaries(content) {
  const ends = new Set();
  let offset = 0, fence = null, inline = 0;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null; ends.add(offset + line.length);
      }
      offset += line.length; continue;
    }
    if (marker) { fence = {char: marker[1][0], length: marker[1].length}; offset += line.length; continue; }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '`') {
        let count = 1; while (line[i + count] === '`') count++;
        if (!inline) inline = count; else if (inline === count) inline = 0;
        i += count - 1; continue;
      }
      if (inline || !/[。！？.!?]/u.test(line[i])) continue;
      let end = i + 1;
      while (end < line.length && /[。！？!?"'”’」』）)\]]/u.test(line[end])) end++;
      // Decimal numbers, addresses, URLs/query strings and exact identifiers are not sentence boundaries.
      if (/[.!?]/u.test(line[i]) && end < line.length && !/\s/u.test(line[end])) continue;
      ends.add(offset + end); i = end - 1;
    }
    if (!inline && !line.trim()) ends.add(offset + line.length);
    offset += line.length;
  }
  ends.add(content.length);
  // Whitespace belongs to the preceding statement; never create a whitespace-only request.
  const bounded = new Set();
  for (let end of ends) { while (end < content.length && /\s/u.test(content[end])) end++; bounded.add(end); }
  return [...bounded].filter(end => end > 0).sort((a, b) => a - b);
}

/** Plan every request before any paid attempt. Saved layouts are reused, never silently re-cut on retry. */
export function summarySegmentRanges(content, fits, saved = null) {
  const ends = summaryBoundaries(content), allowed = new Set(ends);
  if (saved !== null) {
    if (!Array.isArray(saved) || saved.length < 2 || saved.length > MAX_SUMMARY_SEGMENTS) fail('INVALID_SOURCE_SET');
    let next = 0;
    for (const span of saved) {
      if (!span || Object.keys(span).sort().join(',') !== 'end,start' || span.start !== next || !Number.isInteger(span.end) || span.end <= span.start || !allowed.has(span.end)) fail('INVALID_SOURCE_SET');
      if (!fits(span.start, span.end)) fail('INPUT_TOO_LARGE');
      next = span.end;
    }
    if (next !== content.length) fail('INVALID_SOURCE_SET');
    return saved;
  }
  const spans = []; let start = 0, after = 0;
  while (start < content.length) {
    let lo = after, hi = ends.length - 1, best = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(start, ends[mid])) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < after || spans.length >= MAX_SUMMARY_SEGMENTS) fail('INPUT_TOO_LARGE');
    spans.push({start, end: ends[best]}); start = ends[best]; after = best + 1;
  }
  if (spans.length < 2) fail('INPUT_TOO_LARGE');
  return spans;
}

/** Stitch only original text. If the source-span bound is exceeded, retain extra intervening text rather
 * than discard a decision or ask another model to rewrite already grounded evidence. */
export function mergeSummarySegments(source, claims, limit) {
  if (!claims.length) fail('INVALID_SOURCE_SET');
  const spans = [];
  for (const claim of [...claims].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (claim.memory_id !== source.memory_id || claim.revision !== source.revision || !Number.isInteger(claim.start) || !Number.isInteger(claim.end) || claim.start < 0 || claim.end <= claim.start || claim.end > source.content.length || source.content.slice(claim.start, claim.end) !== claim.quote) fail('INVALID_SOURCE_SET');
    const last = spans.at(-1);
    if (last && claim.start <= last.end) last.end = Math.max(last.end, claim.end);
    else spans.push({start: claim.start, end: claim.end});
  }
  while (spans.length > limit) {
    let nearest = 0;
    for (let i = 1; i < spans.length - 1; i++) if (spans[i + 1].start - spans[i].end < spans[nearest + 1].start - spans[nearest].end) nearest = i;
    spans.splice(nearest, 2, {start: spans[nearest].start, end: spans[nearest + 1].end});
  }
  return spans.map(span => ({memory_id: source.memory_id, revision: source.revision, ...span, quote: source.content.slice(span.start, span.end)}));
}
