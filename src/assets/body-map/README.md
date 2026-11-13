# PillAlly body map

Front-view clinical silhouettes for the Log event screen. Not yet approved for the app.

| File | What it is |
| --- | --- |
| `male.svg`, `female.svg` | Clean masters. `viewBox="0 0 200 520"`. One closed `#outline` path and one open `#chest-line` (pec or bust suggestion). Default light fill `#D9E4F4` and stroke `#2A4A78` — restyle via those IDs. |
| `points.json` | Suggested tap points in viewBox coordinates. **Left / right are the figure’s sides** (anatomical): in this front view the figure’s left is on the viewer’s right. Groin is a neutral midline pelvis point, above the crotch of the silhouette. |
| `preview.png` | Both figures on light and on app navy `#030423` (stroke `#7FA4E6`). |
| `preview-labeled.png` | Same pair, with the suggested dots and labels. |
| `compose.py` | Regenerator. Run with `python3 compose.py`. |

Figures are ~7.5 heads tall, symmetric, arms slightly abducted so elbow / wrist / hand dots don’t crowd the hips. Hands are simplified mittens with a lateral thumb (anatomical position, palms forward). No faces, no explicit anatomy.

Dev’s earlier mannequin screenshot was not on this box; vertical landmarks follow a standard 7.5-head clinical canon so existing tap areas (head, chest, abdomen, arms, legs) should land in roughly the same places. Please confirm against the current Log event layout before merging.
