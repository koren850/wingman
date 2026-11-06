# Wingman brand

The Wingman logo is a calm capybara with a yuzu on its head: one tilted ear, closed eyes and a soft smile. A night colour variant is used on dark backgrounds, and the banner includes an answer card.

To regenerate every asset, run `./build.sh` (it needs `app/node_modules`, so run `pnpm install` in `app/` first).
`build.py` is the single source. Edit it, not the generated files.

| File | Use |
|---|---|
| `svg/mark.svg`, `png/mark-512.png` | Character on light backgrounds |
| `svg/mark-night.svg`, `png/mark-night-512.png` | Character on dark backgrounds |
| `svg/mark-32.svg`, `svg/mark-16.svg` | Simplified marks for small sizes |
| `svg/icon.svg`, `png/icon-*.png` | App icon (night tile), 16 to 1024 px |
| `svg/icon-day.svg`, `png/icon-day-512.png` | Alternative light app icon |
| `Wingman.icns` | macOS app icon (Apple grid padding) |
| `wingman.ico` | Windows app icon |
| `png/trayTemplate.png`, `@2x` | macOS menu-bar icon (template image) |
| `svg/lockup.svg`, `svg/lockup-dark.svg`, `png/lockup*.png` | Character + "wingman" wordmark |
| `svg/banner.svg`, `png/banner.png` | 1200x630 README / social banner |

The GitHub social preview image is [`docs/ux/social-preview.png`](../docs/ux/social-preview.png) (upload it under the repository's Settings, Social preview).

Colours: capy brown `#9A6B3F`, yuzu `#F59E0B`, mint `#CDE8D8`, night navy `#12263A`, cocoa `#3B2414`.
Fonts: Unbounded Bold for the wordmark and Baloo 2 for the tagline and labels (both Google Fonts, SIL OFL). The lockup and banner SVGs need these fonts installed to render text; the PNGs do not.
