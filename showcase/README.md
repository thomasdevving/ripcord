# Ripcord — Top 10 Showcase deck

`index.html` is the offline-first stage deck for the 5–6 minute Top 10
Showcase. It uses only local CSS, JavaScript and the bundled Ripcord logo. There
are no font, analytics or asset requests. The report button is the only external
link.

## Present

Open `index.html` in Chrome or Safari, then use:

| Key | Action |
| --- | --- |
| `→`, `Space`, click right | Next slide |
| `←`, click left | Previous slide |
| `F` | Fullscreen |
| `N` | Toggle speaker notes |
| `B` | Enter/leave the three-slide demo backup |
| `Home` / `End` | First/last slide |

`N` is intended for rehearsal. With a mirrored projector the notes are visible
to the audience too; close them before going fullscreen on stage.

The normal sequence contains seven slides. At slide 3, switch to the real
Ripcord site, select the opt-in Mobula second layer for Compound III, start the
analysis and then use the completed Compound report for the explanation. Spend
roughly 2:50 on the product. Return to slide 4 for the technical process.

The exact read-aloud scripts and failure fallbacks for the recorded backup and
the live product demo are in [`DEMO_SCRIPTS.md`](DEMO_SCRIPTS.md).

If the live product fails, return to slide 3 and press `B`. The backup sequence
shows the authority map, fork differential and zero-second verdict at projector
scale. Press `B` after the third backup slide to resume at the process slide.

## Demo URL

The `Open report` button defaults to the published static Compound report. To
point it at a different deployment without editing the deck, append a URL-encoded
`demo` query parameter:

```text
index.html?demo=https%3A%2F%2Fexample.com%2Freport%2Fcompound-comet-cusdcv3
```

For the actual showcase, keep these browser tabs open before going on stage:

1. this deck;
2. the new-analysis screen;
3. the completed Compound III report;
4. the local backup recording.

## Timing

| Segment | Target |
| --- | ---: |
| Hook + product | 1:00 |
| Live product demo | 2:50 |
| Process | 0:35 |
| Mobula implementation | 0:45 |
| Roadmap + close | 0:35 |
| **Total** | **5:45** |

Rehearse toward 5:20–5:30; the remaining time is stage/AV buffer.

## PDF backup

Use the browser's Print command and select **Save as PDF** with:

- landscape orientation;
- background graphics enabled;
- margins set to none;
- scale set to 100%.

Print CSS exports the seven main slides and leaves out presenter controls and
the demo-backup sequence. Save the PDF and the entire `showcase` folder on the
USB drive. The folder is self-contained.

## Stage checklist

- Disable notifications and automatic sleep.
- Use 16:9 mirroring, not an extended desktop you have not rehearsed.
- Set the live site to 125–150% browser zoom.
- Start the analysis once, then move immediately to the completed report.
- Keep the backup MP4 as a separate, directly playable file.
- Do not depend on the live analysis finishing before the conclusion.
