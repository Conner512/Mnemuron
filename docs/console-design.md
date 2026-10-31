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
- `web/console/overview-ux.css`, `memory-map-ux.css`, `summary-reader.css`: scoped exploration layout,
  graph interaction states and source-first summary reading. These are bundled, not new public asset routes.
- `web/console/visuals.mjs`: page views, the escaping `html` template tag, the fixed local icon set and the
  category colour groups (`categoryGroup`).
- `web/console/actions.mjs`: owner pages, overview diagnostics and account-bound foreground activity refresh.
- `web/console/memory-map.mjs`: the graph canvas, stable-key multi-selection and source-memory panels.
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

Geometry: `--radius` 12px for cards, `--radius-sm` 7px for controls, 40px form controls and 38px header controls, 2px ink outlines on cards,
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

- **Overview hierarchy**: graph and activity first, with compact counts and a time range. At desktop widths the
  two outer cards share one height rule and align at both edges; long content scrolls inside rather than resizing
  one card. Narrow layouts stack them. **Filters** is a compact, bounded overlay inside the graph, not an inline
  form: opening, closing, selecting and paging do not move the graph or activity card. Time/type controls and
  node browsing use separate tabs, with eight nodes per page and bounded internal scrolling. The panel closes
  on Escape or outside click, with keyboard focus restored where appropriate. It contains no memory search or
  project/task controls; the whole-library association surface has been removed. Search belongs to the Memory
  Library, linked from the overview. Processing diagnostics and library statistics are ordinary visible sections
  below the hero, read by scrolling rather than expansion. Search shortcuts focus existing page inputs only;
  on an overview with no search input they do not navigate away or recreate the removed form.
- **Memory map**: a bounded, authorized active-memory snapshot from `attention`. Keywords, topics and type hubs
  are connection points, not proof of entity identity or causality. Large samples use aggregation while retaining
  access to every returned source. Labels avoid collisions; if a label cannot fit, its node remains visible and
  its full name remains available by hover or the accessible node directory.
  Ordinary click, Enter and Space toggle nodes without modifier keys. Multiple selections form a **union** of
  source IDs within the displayed graph, with overlapping memories counted once. A reserved single-line selected
  node strip scrolls horizontally and cannot grow the card. Selected-node chips, clear,
  Escape and empty-canvas clicks provide explicit exits. Opening an original is a separate action.
  Stable keys survive layout and language changes; removed keys cannot select an unrelated replacement node.
  While filters are open, results do not obscure node browsing. An explicit selected-memory action closes the
  filter and opens the result list. Selection, hover and keyboard focus are different states. Deselection clears transient highlights and pulses
  while preserving keyboard-only focus affordances. Drag pans and the existing zoom controls remain available.
- **Live activity**: the latest eight audit events for the current account, independent of graph filters. It
  reads on entry, manual refresh and visible-tab resume, and every 30 seconds while visible and unpaused. This is
  a bounded polling snapshot, not a push subscription or a guarantee that all intervening events are shown.
  Page reads belong to the system audit group, so polling does not create its own memory activity. The feed shows
  refresh state, last successful update, event dates and recorded outcomes. Failed updates retain the previous
  snapshot. Missing outcomes stay unknown; lexical-subquery references are never called final search hits.
  Only newly observed successful events animate once; initial history and unchanged refreshes do not replay.
  Hiding, pausing or leaving the page stops background animation and automatic refresh.
- **Summary reader**: human scope and date precede content. List previews preserve separate, source-bound
  excerpts; historical/outdated entries are folded and never displayed as current facts. Detail pages group
  exact quotations by source and revision. Only identical source/revision/range quotations are deduplicated;
  equal wording from different sources is not merged. Originals and their revisions remain explicit links.
  Page/fragment continuation, source coverage and end-of-content are distinct signals. Internal IDs, character
  ranges and quality actions remain available after the reading/navigation area, in a disclosure. These views
  do not invent a narrative, rewrite original memories or claim factual validation. List counts describe the
  current page, not an unqueried global total.
- **Pipeline**: written → scrubbed → typed → keywords → semantic index → used, 7-day counts, each stage linking
  to where it is managed. Only stages with real daily data get a sparkline.
- **Version chain** (detail pane): corrections are replacement records, so the chain follows supersedes links,
  newest first; each version says why it was made and can show its change inline (deleted text struck in red,
  added text in green).
- **Navigation**: icon + label under small monospace group labels. The current page is an outlined card in its
  group's colour with a hard shadow. On narrow screens all nine active destinations stay available in one
  horizontally scrollable keyboard/touch row, rather than occupying the first viewport with the desktop menu.
  Projects & tasks is paused in navigation and discovery. Existing authenticated project/task bookmarks remain
  compatible with a visible paused notice; no stored data, authorization boundary, backend API or connection
  grant is deleted or implicitly downgraded. Hiding a UI destination is not access control.
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

## Interaction and isolation acceptance

All browser fixtures use synthetic accounts and disposable loopback services. Do not use production memory
content, screenshots, sessions or a live model to reproduce these UI checks.

- `scripts/test-console-memory-map.mjs`: first-fold graph/activity geometry, pointer/keyboard multi-selection,
  unique source unions, cancelled highlight state, resize, language, reduced motion, failed reads and scope bounds.
- `scripts/test-console-overview-ux.mjs`: foreground polling, manual/pause/error states, initial-history behavior,
  aligned outer-card edges, overlay geometry before/after interaction, bounded multi-select pagination, always
  visible lower sections, library-only search, narrow navigation and cross-tab account changes.
- `scripts/test-console-control-alignment.mjs`: real browser geometry of adjacent input/button/menu controls
  across memory, connection, processing and related pages in both languages and desktop/narrow viewports.
- `scripts/test-console-summary-reader.mjs`: Chinese/English reading at desktop and narrow widths, exact source
  text, source back-navigation, current/history distinctions, normal pagination and explicitly reduced-budget
  synthetic quotation-fragment continuation.

The authenticated BFF binds `/console-api/` replies with `x-mnemuron-account-id`. Successful reads must match the
page's request account/epoch before JSON is rendered. A cookie changed by another tab therefore clears the old
page and returns it to sign-in instead of painting a different account's data under the old identity. Frontend
and BFF changes ship together; stripping this response header causes the reader to fail closed.
