# PillAlly — selected cleaner-check, Zellatechs palette

Frank selected this direction on 2026-11-06. These are refined review and developer-handoff assets only; implementation waits on his later OK. Nothing was published, implemented, printed, or sent externally. Application, exploration, Zellatechs brand and business-card files were not modified.

## Exact colors
- Navy #030423: opaque launcher/splash background and wordmark.
- Blue #2965D2: capsule half and check.
- White #FFFFFF: other capsule half; notification glyph.
- Light page #F4F6FB: wordmark and review board.
- No old teal, caregiver blue, padlock-Z, purple, gradients or shading. Antialiased boundary pixels are expected color blends, not additional fills.

## Files
- mark.svg — clean transparent capsule/check vector, 1024-unit viewBox.
- adaptive-foreground.svg — transparent mark-only vector on a 108×108 canvas, no baked-in background. Pair with separate #030423 background.
- foreground-1024.png — transparent 1024×1024 mark-only foreground, same placement as adaptive SVG.
- icon-1024.png — opaque navy 1024×1024 launcher candidate.
- master-512.png — 512×512 rounded-square master, transparent outside corners.
- notification.svg — 24-unit white capsule with negative-space check; an optically adjusted single-color derivative, not a two-tone launcher image.
- notification-24.png — 24×24 white-only RGB glyph with transparent check and background; intended as 24dp mdpi reference. Use vector/density-specific rendering for production Android integration.
- splash-1080.png — 1080×1920 portrait, centered mark on solid #030423. Scale/center rather than stretch when integrating.
- wordmark.png — 1400×360 PillAlly horizontal lockup on #F4F6FB; Lato Bold.
- review-board.png — 1800×1400 presentation, safe zone, mask checks, actual 96/48px launchers, native 24px notification plus pixel enlargement, and hex list.
- build.py — reproducible SVG-first rendering and board composition.

## Geometry and refinements
Preserves the selected capsule's 40° rising tilt, 568:224 base ratio, straight equal two-tone split and bold upright check. Analytical vector bounds replace raster crop/resize centering; check terminals have slightly more consistent weight (roughly 2 source units heavier). The mark occupies 61.6×56.3 of the 108 canvas, fully inside the central 66×66 safe square (18-unit inset). Notification glyph uses more of its dedicated 24px canvas and a slightly stronger transparent check cutout for legibility. It deliberately omits the two-tone split to comply with monochrome small-icon rendering.

The adaptive SVG is a design source, not an Android VectorDrawable XML package. Dev must convert/validate in Android tooling and obtain Frank's approval before integration or shipping. Circle/squircle masks are preview checks, not OS screenshots.
