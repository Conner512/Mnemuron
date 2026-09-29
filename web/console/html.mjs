// Escaping template tag for console markup. Every interpolated value is HTML-escaped
// unless it is itself an html`` fragment or explicitly wrapped with trusted().
// Arrays are joined; null, undefined and false render as nothing.
const ENTITIES = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
class Markup {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
const render = value => value === null || value === undefined || value === false ? ''
  : Array.isArray(value) ? value.map(render).join('')
  : value instanceof Markup ? value.value
  : String(value).replace(/[&<>"']/g, c => ENTITIES[c]);
export const html = (strings, ...values) => new Markup(strings.reduce((out, part, i) => out + part + (i < values.length ? render(values[i]) : ''), ''));
/** Mark fixed, locally generated markup (icons, other fragments) as already safe. Never pass user data. */
export const trusted = value => new Markup(String(value));
