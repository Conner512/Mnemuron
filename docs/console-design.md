# Console design: Ink Archive

The console presents memories like a personal archive: paper, ink and a single seal-red accent. Every
memory is a catalogued record with a source and a revision; the interface stays calm and quiet so that
content, provenance and permission boundaries carry the page.

## Files

- `web/console/styles.css`: design tokens, layout and components.
- `web/console/controls.css`: native-select enhancement, write dialogs and connections.
- `web/console/visuals.mjs`: page views, the escaping `html` template tag and the fixed local icon set.

The server bundles the files listed in `STYLESHEETS` (`web/console/render.mjs`) into the single
`/assets/styles.css` response, so CSP and ingress rules are unchanged. There are no decorative skin layers.

Browsers may load only the asset paths the public ingress allows (see
[`console-ingress.example.yml`](console-ingress.example.yml)): `styles.css`, `favicon.svg` and seven modules. A new browser module
must either be folded into an existing one or ship together with a matching ingress route; otherwise the
module graph fails behind the tunnel and pages stay on "Loading". A test walks the browser import graph and
checks it against that allowlist.

## Logo

A seal inside a pair of corner quotes 「■」: the quotes cite the source, the seal is the memory kept on record.
It carries the product's core promise — every memory keeps its provenance — and reuses the accent's meaning of
"current, confirmed".

- 48×48 grid. Quotes: `M5 19V5h14` and `M43 29v14H29`, square caps, mitred corners. Seal: an 18×18 square at 15,15.
- Quote stroke 4 at display sizes, 4.5 in the 34px sidebar/sign-in mark, 5–6 at 32px and below.
- Colours: quotes follow the text colour (`--text`; paper on dark backgrounds), the seal follows `--accent`.
  The wordmark is set in the serif face next to the mark.
- `web/console/favicon.svg` uses a fixed vermilion seal and switches its quotes to paper colour under
  `prefers-color-scheme: dark`. It is served at `/assets/favicon.svg`, so the page CSP stays `img-src 'self'`.

## Tokens

Theme blocks (`[data-theme="a|b|c"]`) contain colours only; geometry lives in `:root`. The three themes
share one light palette and differ only in the accent:

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#F5F1E8` paper | Page background, sidebar, top bar |
| `--surface` | `#FFFDF8` card stock | Cards, detail pane, sign-in form |
| `--surface-2` | `#F0EADD` | Tracks, quiet fills |
| `--soft` | `#EBE3D1` sand | Current page, selected row, focus halo |
| `--border` / `--line` | `#DCD4C3` / `#CFC6B3` | Hairline rules / quiet outlines |
| `--muted` | `#5F5A50` | Secondary text, icons, form-control borders |
| `--text` | `#1C1B18` ink | Body text, primary buttons, strong rules |
| `--accent` | a `#AE3F2C` vermilion · b `#2E4A7A` indigo · c `#2F6B57` pine | Current marker, confirmations |
| `--good` / `--warn` / `--bad` | `#3B6B4F` / `#8A5A12` / `#9B2C1F` | Verified / in progress / danger |

Geometry: `--radius` 2px everywhere, 36–38px controls, 1px hairlines with a 1.5px ink rule above
section headings, table heads and stat tiles. No gradients, glow, blur or glass.

There is no dark mode for now; the appearance page offers the accent and the interface language.

## Type

- Headings, wordmark and figures: serif (`--font-serif`, system Songti / Palatino / Iowan).
- Body and controls: system sans (`--font-sans`, PingFang SC / Segoe UI / Microsoft YaHei).
- IDs, times, counts and small labels: monospace (`--font-mono`).

System fonts only: the CSP allows no external font source, and CJK web fonts are large.

## Components

- **Navigation**: icon + label, grouped under small monospace labels. The current page gets a sand
  background, bold label and an accent icon. No route codes.
- **Buttons**: primary = ink fill; secondary = ink outline; quiet = text only. The submit button of an
  explicit operation dialog, and OAuth consent, use the accent (a "seal" confirming the action).
  Revoke, retract, disable and cancel actions use the danger colour.
- **Status**: shape and words carry the meaning, colour only supports it — filled square for active,
  hollow square for superseded or in progress, a dash and strike-through for retracted.
- **Notices and policy boxes**: a 1.5px ink rule on top, no coloured side bars.
- **Icons**: 24px grid, 1.5px stroke, square caps and mitred joins (`visuals.mjs`).

All motion stops under `prefers-reduced-motion`.

The design canvas with the full set of screens (library, overview, connections, security, sign-in,
registration, authenticator, recovery codes and OAuth consent) is kept outside the repository.
