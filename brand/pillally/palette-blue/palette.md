# PillAlly in-app palette — navy / blue

Proposal to move the app off the current dark teal (`#0E1716` / `#4FC2A6`) and onto the approved logo colours: navy `#030423` and blue `#2965D2`. Zellatechs purple `#7116D1` is recorded as an optional decorative accent only and is not used on the Today mockups or for taken / missed / due states.

These files are for Frank to review. They are not approved for the live app until he says yes.

## Brand anchors

| Name | Hex | Use |
| --- | --- | --- |
| Navy | `#030423` | Dark-mode page background; light-mode primary text |
| Blue | `#2965D2` | Primary fill, borders, light-mode accent text, light-mode focus |
| Purple (optional) | `#7116D1` | Spare decorative accent only. **2.62:1 on navy** (fails UI 3:1). **7.67:1 on white**. Do not use for text or critical states on dark surfaces. |

## Dark mode

| Token | Hex | Role |
| --- | --- | --- |
| `background` | `#030423` | Page canvas. Dark mode uses the logo navy. |
| `surface` | `#12173A` | Cards, tab bar, log-event button fill, selected segment thumb. |
| `elevated` | `#1A2050` | Sheets, dialogs, toast-adjacent raised surfaces. In light mode this is the same as surface (already white). |
| `sunk` | `#01021A` | Segment track, meter tracks, inset wells. |
| `border` | `#32387A` | Card and input 1.5px strokes; tab-bar hairline. |
| `primary_accent` | `#2965D2` | Logo blue. Use for fills, dashed/solid borders, key chrome — not for small text on dark surfaces (see accent_text). |
| `accent_text` | `#7FA4E6` | Interactive labels, links, Log event, selected segment/tab text. Lighter than logo blue in dark mode so it meets 4.5:1. |
| `primary_text` | `#E8EBF8` | Headings and body. |
| `muted_text` | `#9AA0BC` | Eyebrows, hints, supporting copy, unselected tabs. |
| `success` | `#3DCF8A` | Taken / on-time. A true green, kept distinct from the blue accent. |
| `warning` | `#F0B04A` | Due / late. Light-mode warning is darker than the current #B26B00 so it meets 4.5:1 on white and on the page background. |
| `danger` | `#F2867C` | Missed / error / refill. |
| `button_fill` | `#2965D2` | Primary filled buttons (e.g. I took my medicine). Same as primary_accent. |
| `button_text` | `#FFFFFF` | Text and icons on button_fill. White passes 5.4:1 on #2965D2. |
| `tab_selected_bg` | `#1A2A58` | Selected tab pill (maps to accent_soft). |
| `tab_selected_text` | `#7FA4E6` | Selected tab label (maps to accent_text). |
| `tab_unselected` | `#9AA0BC` | Inactive tab labels (maps to muted_text). |
| `focus_ring` | `#7FA4E6` | 3px focus outline. Dark mode uses the lighter accent so the ring stays 3:1 on elevated surfaces; logo blue on #1A2050 is only 2.84:1. |
| `accent_soft` | `#1A2A58` | Selected-tab / chip / toggle wash. |
| `success_soft` | `#0C2A1C` | Taken chips, on-time calendar days, success banners. |
| `warning_soft` | `#3A2B10` | Due wells and warning banners. |
| `danger_soft` | `#3D1A17` | Missed wells and error banners. |
| `accent_ink` | `#FFFFFF` | Ink on a primary_accent fill (checkmarks on a blue or filled-accent control). White. |

### Contrast — dark

| Pair | Foreground | Background | Ratio | Min | Result |
| --- | --- | --- | ---: | ---: | --- |
| Primary text on background | `#E8EBF8` | `#030423` | 16.90:1 | 4.5:1 | PASS |
| Primary text on surface | `#E8EBF8` | `#12173A` | 14.61:1 | 4.5:1 | PASS |
| Primary text on elevated | `#E8EBF8` | `#1A2050` | 12.93:1 | 4.5:1 | PASS |
| Primary text on sunk | `#E8EBF8` | `#01021A` | 17.24:1 | 4.5:1 | PASS |
| Muted text on background | `#9AA0BC` | `#030423` | 7.77:1 | 4.5:1 | PASS |
| Muted text on surface | `#9AA0BC` | `#12173A` | 6.72:1 | 4.5:1 | PASS |
| Muted text on elevated | `#9AA0BC` | `#1A2050` | 5.95:1 | 4.5:1 | PASS |
| Muted text on sunk | `#9AA0BC` | `#01021A` | 7.93:1 | 4.5:1 | PASS |
| Accent text on background | `#7FA4E6` | `#030423` | 7.99:1 | 4.5:1 | PASS |
| Accent text on surface | `#7FA4E6` | `#12173A` | 6.91:1 | 4.5:1 | PASS |
| Accent text on elevated | `#7FA4E6` | `#1A2050` | 6.11:1 | 4.5:1 | PASS |
| Accent text on accent-soft (selected tab / chips) | `#7FA4E6` | `#1A2A58` | 5.51:1 | 4.5:1 | PASS |
| Button text on button fill | `#FFFFFF` | `#2965D2` | 5.40:1 | 4.5:1 | PASS |
| Tab selected text on tab selected background | `#7FA4E6` | `#1A2A58` | 5.51:1 | 4.5:1 | PASS |
| Tab unselected on surface (tab bar) | `#9AA0BC` | `#12173A` | 6.72:1 | 4.5:1 | PASS |
| Success on background | `#3DCF8A` | `#030423` | 10.03:1 | 4.5:1 | PASS |
| Success on surface | `#3DCF8A` | `#12173A` | 8.67:1 | 4.5:1 | PASS |
| Success on success-soft | `#3DCF8A` | `#0C2A1C` | 7.69:1 | 4.5:1 | PASS |
| Warning on background | `#F0B04A` | `#030423` | 10.53:1 | 4.5:1 | PASS |
| Warning on surface | `#F0B04A` | `#12173A` | 9.11:1 | 4.5:1 | PASS |
| Warning on warning-soft | `#F0B04A` | `#3A2B10` | 7.18:1 | 4.5:1 | PASS |
| Danger on background | `#F2867C` | `#030423` | 8.11:1 | 4.5:1 | PASS |
| Danger on surface | `#F2867C` | `#12173A` | 7.01:1 | 4.5:1 | PASS |
| Danger on danger-soft | `#F2867C` | `#3D1A17` | 6.24:1 | 4.5:1 | PASS |
| Primary accent (fill/border) vs background, UI 3:1 | `#2965D2` | `#030423` | 3.72:1 | 3.0:1 | PASS |
| Primary accent vs surface, UI 3:1 | `#2965D2` | `#12173A` | 3.21:1 | 3.0:1 | PASS |
| Focus ring vs background, UI 3:1 | `#7FA4E6` | `#030423` | 7.99:1 | 3.0:1 | PASS |
| Focus ring vs surface, UI 3:1 | `#7FA4E6` | `#12173A` | 6.91:1 | 3.0:1 | PASS |
| Focus ring vs elevated, UI 3:1 | `#7FA4E6` | `#1A2050` | 6.11:1 | 3.0:1 | PASS |
| Button fill vs background, UI 3:1 | `#2965D2` | `#030423` | 3.72:1 | 3.0:1 | PASS |

## Light mode

| Token | Hex | Role |
| --- | --- | --- |
| `background` | `#EEF1F8` | Page canvas. Dark mode uses the logo navy. |
| `surface` | `#FFFFFF` | Cards, tab bar, log-event button fill, selected segment thumb. |
| `elevated` | `#FFFFFF` | Sheets, dialogs, toast-adjacent raised surfaces. In light mode this is the same as surface (already white). |
| `sunk` | `#E2E6F2` | Segment track, meter tracks, inset wells. |
| `border` | `#C8CEE0` | Card and input 1.5px strokes; tab-bar hairline. |
| `primary_accent` | `#2965D2` | Logo blue. Use for fills, dashed/solid borders, key chrome — not for small text on dark surfaces (see accent_text). |
| `accent_text` | `#2965D2` | Interactive labels, links, Log event, selected segment/tab text. Lighter than logo blue in dark mode so it meets 4.5:1. |
| `primary_text` | `#030423` | Headings and body. |
| `muted_text` | `#555C78` | Eyebrows, hints, supporting copy, unselected tabs. |
| `success` | `#0D6E43` | Taken / on-time. A true green, kept distinct from the blue accent. |
| `warning` | `#8A5500` | Due / late. Light-mode warning is darker than the current #B26B00 so it meets 4.5:1 on white and on the page background. |
| `danger` | `#B3261E` | Missed / error / refill. |
| `button_fill` | `#2965D2` | Primary filled buttons (e.g. I took my medicine). Same as primary_accent. |
| `button_text` | `#FFFFFF` | Text and icons on button_fill. White passes 5.4:1 on #2965D2. |
| `tab_selected_bg` | `#E8F0FC` | Selected tab pill (maps to accent_soft). |
| `tab_selected_text` | `#2965D2` | Selected tab label (maps to accent_text). |
| `tab_unselected` | `#555C78` | Inactive tab labels (maps to muted_text). |
| `focus_ring` | `#2965D2` | 3px focus outline. Dark mode uses the lighter accent so the ring stays 3:1 on elevated surfaces; logo blue on #1A2050 is only 2.84:1. |
| `accent_soft` | `#E8F0FC` | Selected-tab / chip / toggle wash. |
| `success_soft` | `#D7F3E4` | Taken chips, on-time calendar days, success banners. |
| `warning_soft` | `#FBEBD0` | Due wells and warning banners. |
| `danger_soft` | `#F8DEDB` | Missed wells and error banners. |
| `accent_ink` | `#FFFFFF` | Ink on a primary_accent fill (checkmarks on a blue or filled-accent control). White. |

### Contrast — light

| Pair | Foreground | Background | Ratio | Min | Result |
| --- | --- | --- | ---: | ---: | --- |
| Primary text on background | `#030423` | `#EEF1F8` | 17.76:1 | 4.5:1 | PASS |
| Primary text on surface | `#030423` | `#FFFFFF` | 20.09:1 | 4.5:1 | PASS |
| Primary text on elevated | `#030423` | `#FFFFFF` | 20.09:1 | 4.5:1 | PASS |
| Primary text on sunk | `#030423` | `#E2E6F2` | 16.10:1 | 4.5:1 | PASS |
| Muted text on background | `#555C78` | `#EEF1F8` | 5.83:1 | 4.5:1 | PASS |
| Muted text on surface | `#555C78` | `#FFFFFF` | 6.59:1 | 4.5:1 | PASS |
| Muted text on elevated | `#555C78` | `#FFFFFF` | 6.59:1 | 4.5:1 | PASS |
| Muted text on sunk | `#555C78` | `#E2E6F2` | 5.28:1 | 4.5:1 | PASS |
| Accent text on background | `#2965D2` | `#EEF1F8` | 4.78:1 | 4.5:1 | PASS |
| Accent text on surface | `#2965D2` | `#FFFFFF` | 5.40:1 | 4.5:1 | PASS |
| Accent text on elevated | `#2965D2` | `#FFFFFF` | 5.40:1 | 4.5:1 | PASS |
| Accent text on accent-soft (selected tab / chips) | `#2965D2` | `#E8F0FC` | 4.71:1 | 4.5:1 | PASS |
| Button text on button fill | `#FFFFFF` | `#2965D2` | 5.40:1 | 4.5:1 | PASS |
| Tab selected text on tab selected background | `#2965D2` | `#E8F0FC` | 4.71:1 | 4.5:1 | PASS |
| Tab unselected on surface (tab bar) | `#555C78` | `#FFFFFF` | 6.59:1 | 4.5:1 | PASS |
| Success on background | `#0D6E43` | `#EEF1F8` | 5.58:1 | 4.5:1 | PASS |
| Success on surface | `#0D6E43` | `#FFFFFF` | 6.31:1 | 4.5:1 | PASS |
| Success on success-soft | `#0D6E43` | `#D7F3E4` | 5.36:1 | 4.5:1 | PASS |
| Warning on background | `#8A5500` | `#EEF1F8` | 5.49:1 | 4.5:1 | PASS |
| Warning on surface | `#8A5500` | `#FFFFFF` | 6.21:1 | 4.5:1 | PASS |
| Warning on warning-soft | `#8A5500` | `#FBEBD0` | 5.29:1 | 4.5:1 | PASS |
| Danger on background | `#B3261E` | `#EEF1F8` | 5.78:1 | 4.5:1 | PASS |
| Danger on surface | `#B3261E` | `#FFFFFF` | 6.54:1 | 4.5:1 | PASS |
| Danger on danger-soft | `#B3261E` | `#F8DEDB` | 5.12:1 | 4.5:1 | PASS |
| Primary accent (fill/border) vs background, UI 3:1 | `#2965D2` | `#EEF1F8` | 4.78:1 | 3.0:1 | PASS |
| Primary accent vs surface, UI 3:1 | `#2965D2` | `#FFFFFF` | 5.40:1 | 3.0:1 | PASS |
| Focus ring vs background, UI 3:1 | `#2965D2` | `#EEF1F8` | 4.78:1 | 3.0:1 | PASS |
| Focus ring vs surface, UI 3:1 | `#2965D2` | `#FFFFFF` | 5.40:1 | 3.0:1 | PASS |
| Focus ring vs elevated, UI 3:1 | `#2965D2` | `#FFFFFF` | 5.40:1 | 3.0:1 | PASS |
| Button fill vs background, UI 3:1 | `#2965D2` | `#EEF1F8` | 4.78:1 | 3.0:1 | PASS |

## Status

All listed text and UI pairs meet WCAG AA.

## Implementation notes for Dev

Map onto the existing CSS variables in `style.css` as follows:

| Existing / new variable | Token |
| --- | --- |
| `--bg` | `background` |
| `--surface` | `surface` |
| `--elevated` (new) | `elevated` |
| `--sunk` | `sunk` |
| `--line` | `border` |
| `--fg` | `primary_text` |
| `--muted` | `muted_text` |
| `--accent` | `primary_accent` (`#2965D2`) for **fills and borders** |
| `--accent-text` (new) | `accent_text` for **labels and links** |
| `--accent-ink` | `accent_ink` (`#FFFFFF`) |
| `--accent-soft` | `accent_soft` |
| `--ok` / `--ok-soft` | `success` / `success_soft` |
| `--warn` / `--warn-soft` | `warning` / `warning_soft` |
| `--bad` / `--bad-soft` | `danger` / `danger_soft` |
| `--focus` (new, or the existing 3px outline colour) | `focus_ring` |

**Why `--accent-text` is a separate token.** Logo blue `#2965D2` on navy is only 3.72:1. That is enough for large text and for a 3:1 UI border, but it fails AA for normal text — including “My medicines”, “+ Log event”, and the selected tab. In dark mode those labels use `#7FA4E6` (same hue, lighter). In light mode `#2965D2` already passes 5.40:1 on white, so both tokens are the same.

**Focus ring.** In dark mode the ring is the lighter accent, not logo blue. Logo blue on the elevated surface `#1A2050` is 2.84:1 and would miss the 3:1 UI minimum.

**Success is green, not blue.** Taken / on-time states must stay visually distinct from the brand accent. Dark `#3DCF8A` and light `#0D6E43` are a true green, not a teal that could be confused with the old accent or the new blue.

**Light-mode warning is darker than the current app.** The teal theme’s `--warn: #B26B00` is 4.20:1 on white and 3.72:1 on the current page background, which already fails AA for small text. The proposed `#8A5500` passes on white, on `#EEF1F8`, and on the warning wash.

**Caregiver accent.** The current CSS overrides caregiver accent to `#2F4FB5` / `#8EA6F2`. The new app-wide blue already lives in that family. Confirm with Frank before removing the override; this palette does not assume that change.

**Light elevated.** There is no step above white, so `elevated` equals `surface` (`#FFFFFF`) in light mode. Use the same border (and, if you add one later, a shadow) to lift sheets.

## Mockups

Built from the measured layout of `/workspace/pillally-brand/feedback/today-green.jpg`. No features were invented; the empty Today state is reproduced as shown, including the hint clipped by the tab bar.

- `today-dark.png` — proposed dark mode
- `today-light.png` — proposed light mode
- `today-compare.png` — current teal screenshot vs proposed dark mode, side by side

## How this was built

Colours and contrast ratios were computed with a small WCAG 2 script (sRGB relative luminance). Mockups were drawn with PIL using the app’s own typefaces — Bricolage Grotesque, Atkinson Hyperlegible, and JetBrains Mono — at the 3× sizes implied by the 1080×2340 screenshot. Status-bar and nav icons, and the seedling emoji, were lifted from the screenshot so the chrome matches the device.
