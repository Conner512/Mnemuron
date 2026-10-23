# Console design: Sticky board

Mnemuron = memory + neuron. The console draws memories as a network on a pinboard: each memory is a small node
coloured by its category group, entities and topics are larger violet nodes that connect the memories naming them,
and reads and writes travel along those links. Every panel is a white card pinned to a cool grey dot-grid board,
outlined in 2px ink with a hard offset shadow; categories are saturated pastel blocks with ink outlines. The page
stays calm so that content, provenance and permission boundaries carry it.

## Files

- `web/console/styles.css`: design tokens, fonts, layout and components.
- `web/console/controls.css`: native-select enhancement, write dialogs, connections, owner pages, the memory map,
  pipeline, version chain and entity map.
- `web/console/visuals.mjs`: page views, the escaping `html` template tag, the fixed local icon set and the
  category colour groups (`categoryGroup`).
- `web/console/actions.mjs`: owner pages, the overview status, the memory map canvas (`memoryMap`) and the entity
  map side panel.
- `web/console/display-font.woff2`, `web/console/mono-font.woff2`: self-hosted typefaces (latin subsets, SIL OFL
  1.1, see `web/console/FONTS-LICENSE.txt`). The publication check pins both files by content hash.

The server bundles the files listed in `STYLESHEETS` (`web/console/render.mjs`) into the single
`/assets/styles.css` response. There are no decorative skin layers.

Browsers may load only the asset paths the public ingress allows (see
[`console-ingress.example.yml`](console-ingress.example.yml)): `styles.css`, the two font files, `favicon.svg` and
the browser modules. A new browser module or asset must either be folded into an existing one or ship together
with a matching ingress route; otherwise it fails behind the tunnel. A test walks the browser import graph (and
the fonts the stylesheet requests) and checks it against that allowlist.

## Logo

A memory neuron: a violet entity node with a hard ink shadow, linked to three memories in the category colours
(preference pink, project blue, workflow yellow), the same picture as the overview memory map.

- 48×48 grid. Links: from the core at 24,24 to 10,12 / 39,15 / 16,39, 3px ink, round caps. Core: r 10 at 24,24 in
  `--c-ent` with a 3px ink outline and an ink shadow circle offset by 2,2. Memories: r 5 with a 2.5px ink outline.
  A small white highlight (r 2.6 at 21,21) keeps the core readable at 16px.
- Colours are fixed in the SVG (the board palette), so the mark looks the same in the sidebar, on the sign-in pages
  and in the browser tab. The wordmark is set in the display face next to it.
- `web/console/favicon.svg` is the same drawing. It is served at `/assets/favicon.svg`, so the page CSP stays
  `img-src 'self'`.

## Tokens

All tokens live in `:root`. There is one fixed light palette and no theme switching:

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#E6E9EE` board grey | Page background (with the `--dot` grid), sidebar, top bar |
| `--surface` / `--surface-2` | `#FFFFFF` / `#F3F5F8` | Cards, detail pane / quiet fills, map board |
| `--soft` | `#ECEEF3` | Selected row |
| `--ink` / `--line` | `#14171D` | Outlines, hard shadows, primary buttons |
| `--border` | `#CDD2DB` | Hairlines inside cards and tables |
| `--muted` / `--text` | `#4F5664` / `#14171D` | Secondary text, form borders / body text |
| `--accent` | `#5B3FD6` ink violet | Links on hover, focus, current markers |
| `--good` / `--warn` / `--bad` | `#17784E` / `#95580A` / `#C02A36` | Verified / attention / danger text |
| `--c-pref` / `--c-proj` / `--c-flow` / `--c-fact` / `--c-ent` | `#FFA8C2` / `#8FCBFF` / `#FFDA5C` / `#8DEBC6` / `#C4AFFF` | Category and entity blocks |
| `--hard` / `--hard-sm` | `4px 4px 0` / `2px 2px 0` ink | Card and button shadows |
| `--map-style` | `outline` | Map nodes drawn as pastel fills with ink outlines (no glow) |

Node colours are the category groups (`categoryGroup` in `visuals.mjs`): personal and preferences (pink), projects
and decisions (blue), workflows and lessons (yellow), technical (mint), uncategorized (grey), entities and topics
(violet). The same colour marks a category everywhere: map nodes, library row strips, the current navigation item,
pipeline stages, processing capabilities (a coloured band on top of the card), chart series and audit kinds
(reads pink, writes blue, sign-in and credentials yellow). Colour fills always sit inside an ink outline, so text on
them stays ink.

Geometry: `--radius` 12px for cards, `--radius-sm` 7px for controls, 36–38px controls, 2px ink outlines on cards,
buttons and the current navigation item, 1.5px on tags and fields. Buttons carry a 2px hard shadow and press in
(translate, no shadow) when clicked; the primary button is solid ink. There is no glow, blur or gradient light.

There is no dark mode and no appearance page. The only display preference is the interface language.

## Type

- Headings, wordmark and figures: Bricolage Grotesque (`--font-display`), heavy weights with tight tracking.
- Body and controls: system sans (`--font-sans`, PingFang SC / Segoe UI / Microsoft YaHei).
- IDs, times, counts and small labels: Martian Mono (`--font-mono`).

Only latin subsets are self-hosted (`font-src 'self'`); Chinese text always uses the system fonts, which are large
as web fonts.

## Components

- **Memory map** (overview hero, entity page): a canvas of the newest active memories and the current entities that
  name them, read from the `attention` view. Without entities, topics shared by at least two memories become the
  violet connection points and every memory also links loosely to its category hub (a node in the category
  colour), so one topic's memories of different categories form one network; without such topics, memories gather
  around their category hubs (`mapAnchors` in `actions.mjs`).
  Hovering names a node; a click on a connection point highlights its memories and opens a panel (its categories,
  related points, a library link); a click on a memory opens it in the detail pane. Drag pans; pinch, ctrl+wheel,
  double-click or the zoom buttons zoom. Light
  pulses replay only the latest real reads and writes from the audit log; nothing is animated without an event.
  On the entity page an entity can be chosen on the map or from the side list; its links light up and the panel
  shows its categories and the entities it shares memories with.
- **Live stream**: the latest memory reads and writes. Every console read is audited, so it refreshes on demand
  (open, refresh, tab shown again; at most once a minute), never on a timer.
- **Pipeline**: written → scrubbed → classified → entities → semantic index → used, 7-day counts, each stage linking
  to where it is managed. Only stages with real daily data get a sparkline.
- **Version chain** (detail pane): corrections are replacement records, so the chain follows supersedes links,
  newest first; each version says why it was made and can show its change inline (deleted text struck in red,
  added text in green).
- **Navigation**: icon + label under small monospace group labels. The current page is an outlined card in its
  group's colour with a hard shadow. No route codes.
- **Buttons**: primary = ink fill; secondary = ink outline with a hard shadow; quiet = text only. Revoke, retract, disable and cancel
  actions use the danger colour.
- **Memory selection**: inline, accessibly named checkboxes only when a batch action is granted. Opening a record is
  separate from selecting it. Search placeholders disappear on focus without removing the label.
- **Status**: shape and words carry the meaning, colour only supports it — a filled node for active, a hollow node
  for superseded or in progress, a dash and strike-through for retracted.
- **Icons**: 24px grid, 1.5px stroke, square caps and mitred joins (`visuals.mjs`).
- **Feature status**: the same shape language — filled for live, hollow for planned, half-filled for a partly live
  page, a dash for features deliberately not offered on the web. What each page offers or will offer is listed in
  the feature map; see [console-feature-standard.md](console-feature-standard.md) for the development rules.

All motion stops under `prefers-reduced-motion`: the maps draw once and do not pulse.
