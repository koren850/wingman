# Wingman brand

The final logo: a calm capybara with a yuzu on its head.
(Y1 drawing, one tilted ear, closed "zen" eyes and a soft smile, no headset; Y7 night colours for dark mode; Y10 answer card in the banner.)

Rebuild everything: `./build.sh` (needs `stage0/node_modules`, run `pnpm install` there first).
`build.py` is the single source; edit it, never the generated files.

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

Colours: capy brown `#9A6B3F`, yuzu `#F59E0B`, mint `#CDE8D8`, night navy `#12263A`, cocoa `#3B2414`.
Wordmark font: Unbounded Bold; tagline/labels: Baloo 2 (both Google Fonts, OFL). Text in the lockup/banner SVGs needs the font; the PNGs do not.
