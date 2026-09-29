// Tiny CSS reader for presentation tests: assert intent (selectors, properties,
// media conditions), not exact formatting, so restyling does not break tests.
const clean = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = value => value.trim().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');

function blocks(css) {
  const out = [];let i = 0, depth = 0, start = 0, media = [];
  const text = clean(css);let prelude = '';
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { prelude = text.slice(start, i).trim(); if (prelude.startsWith('@')) { media.push(norm(prelude)); start = i + 1; } else { out.push({selector: prelude, media: media.at(-1) || null, bodyStart: i + 1}); } depth++; start = i + 1; }
    else if (ch === '}') { depth--; const last = out.at(-1); if (last && last.body === undefined) { last.body = text.slice(last.bodyStart, i); } else { media.pop(); } start = i + 1; }
  }
  return out.filter(rule => rule.body !== undefined).map(({selector, media, body}) => ({
    selectors: selector.split(',').map(norm), media,
    declarations: Object.fromEntries(body.split(';').map(d => d.split(/:(.*)/s)).filter(([k, v]) => k && v !== undefined).map(([k, v]) => [k.trim(), norm(v)])),
  }));
}
export function rules(css, {media = null} = {}) {
  return blocks(css).filter(rule => media === undefined || (media === null ? rule.media === null : rule.media?.includes(media)));
}
/** Merged declarations of every rule that lists `selector` (cascade order, last wins). */
export function declarations(css, selector, options) {
  const target = norm(selector);
  return Object.assign({}, ...rules(css, options).filter(r => r.selectors.includes(target)).map(r => r.declarations));
}
export const hasMedia = (css, condition) => blocks(css).some(rule => rule.media?.includes(norm(condition)));
