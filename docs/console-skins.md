# Console skins

The console separates structure from decoration:

- `web/console/styles.css`: layout, components and the colour tokens for the three palettes (`data-theme` a/b/c)
  in dark and light mode (`data-mode`). Palette blocks may contain colours only.
- `web/console/controls.css`: native-select enhancement, write dialogs and connections.
- `web/console/skin-<name>.css`: decoration only, scoped to `[data-skin="<name>"]` on `<html>`.
  It may add backgrounds, pseudo-element ornaments, glow and motion. It must not change layout, content,
  behaviour or the contrast of text tokens, and every animation must stop under `prefers-reduced-motion`.

The server bundles the files listed in `STYLESHEETS` (`web/console/render.mjs`) into the single
`/assets/styles.css` response, so CSP and ingress rules are unchanged.

## Active skin: `hud`

Spacecraft instrument panel: cut-corner panels with bracket corners, tick rulers under section heads,
drifting star field and grid (dark), a white-laboratory variant (light), route codes (`MN-01` …), a status bar
with local time, session and measured core-link latency, and a radar on the overview whose sectors and rim
ticks come from owner-scoped counts only.

## Reserved skins (not implemented)

Each would be a new `skin-*.css` plus palette overrides scoped to `[data-skin=…]`:

| Skin | Direction |
| --- | --- |
| `neon` | Cyberpunk: black base, magenta/cyan neon, scan lines, subtle glitch on hover, high contrast. |
| `holo` | Holographic glass: translucent blurred panels, glowing edges, animated node network backdrop. |
| `crt` | Retro-future terminal: amber or green phosphor, CRT scan lines and curvature vignette, all monospace. |

Switching skins at runtime would add a `skin` preference next to theme/mode/locale in `appearance.mjs`
and the first-paint bootstrap in `render.mjs` (which is CSP-hashed; update the hash test accordingly).
