# Ladder: Brand & logo kit

The mark is rebuilt from the last approved draft, reproduced in
`reference/ladder-logo-approved.png`. The three rails are drawn as vector
polygons and the lettering is traced from the same image. The SVGs are
self-contained, with shapes converted to paths. They can be used without
external fonts.

| Path | Contents |
|---|---|
| `logo/svg/` and `logo/png/` | Symbol, wordmark, horizontal lockup and vertical lockup. Every form is available in Circuit iris, deep purple, graphite, black and white. The PNGs have a transparent background. |
| `app-icon/svg/` | Vector masters of the Circuit, Mono Light and Mono Dark icons. |
| `app-icon/png/` | 16, 24, 32, 48, 64, 128, 256, 512 and 1024 px versions. |
| `app-icon/macos/` | ICNS icons, including the main `ladder-circuit.icns`. |
| `app-icon/windows/` | Multi-resolution ICO icons. |
| `brand/` | Fifteen themes with semantic tokens in JSON and CSS, plus the full prompt for Claude Code. |
| `reference/` | Approved logo and reference color boards. |

## Quick reference

- **Primary logo:** `logo/svg/ladder-horizontal-circuit.svg`.
- **Symbol in the UI:** `logo/svg/ladder-mark-circuit.svg` on light surfaces.
  On dark surfaces use `ladder-mark-white.svg`.
- **macOS icon:** `app-icon/macos/ladder-circuit.icns`.
- **Circuit theme:** iris `#5525CF`, deep purple `#22123C`, citron
  `#ECFC7F`. The icon uses the white mark on deep purple.
- **UI themes:** the selector changes the workspace tokens. The brand and the
  distribution icon stay on Circuit.

The three colors of each palette come from samples of the concept boards.
The semantic UI colors were chosen for use on the app's surfaces. The text,
focus and control tokens were checked against the base combinations. Check the
rendered components in the product after integration.
