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

## Active skin: `liquid`

Liquid glass with a sci-fi setting (`skin-liquid.css`, `data-skin="liquid"`): translucent, refracting glass
panels (blur + saturation everywhere; an SVG displacement filter where `backdrop-filter: url()` is supported),
iridescent rims and specular highlights, floating sidebar/top bar, capsule controls, an iridescent nebula
over a star field with a moving horizon grid, a status bar (local time, session, measured core-link latency) and
the memory hologram on the overview (sectors and rim ticks from owner-scoped counts only).

Performance: full-screen motion underneath many blurred panels forces a re-blur every frame, so the nebula only
fades in once; continuous motion is limited to the horizon grid, radar sweep and small highlights.
`prefers-reduced-motion` stops all animation and `prefers-reduced-transparency` swaps glass for solid surfaces.

## Alternative skin kept: `hud`

`skin-hud.css` (spacecraft instrument panel: cut corners, bracket corners, tick rulers, route codes) is kept in
the repository but not bundled. To use it, set `data-skin="hud"` in `render.mjs` and bundle `skin-hud.css`
instead of `skin-liquid.css`.

## Reserved skins (not implemented)

| Skin | Direction |
| --- | --- |
| `neon` | Cyberpunk: black base, magenta/cyan neon, scan lines, subtle glitch on hover, high contrast. |
| `crt` | Retro-future terminal: amber or green phosphor, CRT scan lines and curvature vignette, all monospace. |

Switching skins at runtime would add a `skin` preference next to theme/mode/locale in `appearance.mjs`
and the first-paint bootstrap in `render.mjs` (which is CSP-hashed; update the hash test accordingly).
