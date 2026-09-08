# Ripcord — showcase deck

`index.html` is the offline-first stage deck for a 5–6 minute showcase. The
presentation is intentionally self-contained: it does **not** switch to a live
demo. Instead, one completed Compound III report is decomposed into readable
slides showing recognition, authority reconstruction, enforced notice, the fork
differential and the final Exit Window.

The deck uses only local CSS, JavaScript and the bundled Ripcord logo. There are
no font, analytics or asset requests. The links on the closing slide are the
only external navigation.

## Present

Open `index.html` in Chrome or Safari, then use:

| Key | Action |
| --- | --- |
| `→`, `Space`, click right | Next slide |
| `←`, click left | Previous slide |
| `F` | Fullscreen |
| `N` | Toggle speaker notes |
| `B` | Enter/leave the three-slide Q&A appendix |
| `Home` / `End` | First/last slide |

`N` is intended for rehearsal. With a mirrored projector the notes are visible
to the audience too; close them before going fullscreen on stage.

## Main sequence

The eleven main slides form one continuous story:

1. the sovereignty question;
2. the three questions to answer before deploying capital into DeFi;
3. the three report outputs;
4. the reconstructed power map;
5. bytecode signature matching and fork behaviour verification, with shortened production code;
6. evidence that the two-day timelock is binding;
7. why the fork is necessary and the A/B/C withdrawal differential;
8. the zero-second effective Exit Window;
9. Mobula-proposed assets and their value for broader coverage;
10. the post-hackathon roadmap, clearly separated from shipped functionality;
11. the closing question.

Speaker notes contain a compact read-aloud narrative and target timestamps. The
deck should land around 5:05 at a calm pace. Do not compensate for nerves by
explaining every label on each slide; the slide itself now carries the product
demonstration.

## Q&A appendix

Press `B` from any main slide to open three hardcoded evidence slides:

1. the `$540.6M` upgrade drain proof, with the required two-day-timelock caveat;
2. the exact boundary between demonstrated capability and Safe impersonation;
3. the present recognition, adapter and liquidity limitations.

These are deliberately outside the main sequence. The drain figure is a strong
technical answer when a judge asks what upgrade authority means in practice,
but it distracts from the simpler zero-second guardian result if introduced
without that question. The limitations slide is useful when judges probe
generality or false confidence.

Press `B` again to return to the main slide from which the appendix was opened.

## Timing

| Segment | Target |
| --- | ---: |
| Hook + problem + product | 1:20 |
| Function recognition | 0:45 |
| Power map + binding notice | 0:55 |
| Why fork + differential + verdict | 1:00 |
| Mobula + roadmap + close | 1:05 |
| **Total** | **5:05** |

Rehearse toward 4:55–5:05; the remaining time is stage and AV buffer.

## PDF backup

Use the browser's Print command and select **Save as PDF** with:

- landscape orientation;
- background graphics enabled;
- margins set to none;
- scale set to 100%.

Print CSS exports the eleven main slides and leaves out presenter controls and
the Q&A appendix. Save both the PDF and the entire `showcase` folder on the USB
drive. The folder is self-contained.

## Stage checklist

- Disable notifications and automatic sleep.
- Use 16:9 mirroring and test the projector before presenting.
- Open the deck locally; no network is required for the presentation.
- Keep the production site, repository and calibration report bookmarked for
  questions, but do not leave the deck during the prepared pitch.
- Rehearse the transition from the Power Map directly into the fork: discovery
  identifies a possible route; matched execution establishes its consequence.
- Never describe an unmatched selector, unsupported adapter or no-effect result
  as safe.
