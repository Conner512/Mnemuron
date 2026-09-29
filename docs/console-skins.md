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

Calm liquid glass (`skin-liquid.css`, `data-skin="liquid"`): one glass material everywhere — backdrop blur and
saturation, a faint top sheen, a hairline specular rim and a soft shadow — over a still colour field of a few
large, low-saturation light pools. Floating sidebar and top bar, capsule controls, system numerals, no glow or
gradient text. Gentle SVG refraction on the sidebar, top bar and metric tiles where `backdrop-filter: url()` is
supported. The overview shows a distribution ring (category shares of active memories, total in the centre).

Sign-in pages add the `aurora` layer (`skin-aurora.css`, `data-skin="liquid aurora"`): iridescent nebula,
star field and horizon grid.

Performance: no continuous full-screen motion underneath the glass, and dialogs avoid backdrop blur, because
every animated or blurred full-viewport layer forces all glass panels to re-blur each frame.
`prefers-reduced-motion` stops animation and `prefers-reduced-transparency` swaps glass for solid surfaces.

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
