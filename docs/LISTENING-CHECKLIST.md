# Listening checklist — editing reliability wave (2026-10-07)

Ear-verification for the editing reliability waves. Automated suites cover the
model and engine paths (browser live verifier: `npm run test:browser:live-editing`,
8 scenarios); **this checklist is the human sign-off** — what the suites cannot
judge is whether it sounds _right_. Total time: ~10 minutes. Use headphones.

Setup: any project with a few audio clips (drag 2–3 loops in) and a scene or
two on the arrangement. Play at a comfortable level.

---

## A. Playback-sync fixes (wave A1 + B3) — the critical ones

| #   | Action                                                       | Listen for                                                                                   |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| A1  | **Delete a clip while it plays**                             | It silences within ~50 ms, smoothly (no click). Before the fix it rang to its scheduled end. |
| A2  | **Click the ruler into the MIDDLE of a playing clip**        | Audio resumes from the click instantly. Before the fix: permanent silence.                   |
| A3  | **Ctrl+E (split at playhead)** while playing                 | No hole, no double-attack at the seam — a gentle 3 ms de-click.                              |
| A4  | **Delete, then Ctrl+Z while playing**                        | The clip comes back AND sounds from the playhead.                                            |
| A5  | **M (mute) a playing clip**, then **M again**                | Mute = de-clicked silence immediately; unmute = resumes from the playhead.                   |
| A6  | **Move a playing clip right, then seek to its new position** | Old spot silences, new spot plays after the seek.                                            |

## B. New editing features (waves B1/B2/snap/zoom-nudge)

| #   | Action                                                                                                                                                                                         | Expect                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| B1  | Select clips → **Ctrl+C, move playhead, Ctrl+V**                                                                                                                                               | Paste lands at the playhead, relative spacing kept. Ctrl+X = copy+delete as one undo.               |
| B2  | **Alt+drag the BODY of an audio clip** (slip)                                                                                                                                                  | Waveform content shifts inside the clip; position/length unchanged. Edges still stretch (Alt+edge). |
| B3  | **J** toggles the snap grid; drag a clip near another clip's edge                                                                                                                              | The edge "catches" the pointer within ~8 px. Grid select in the arrangement toolbar (OFF/1/1/2…).   |
| B4  | **Ctrl+wheel** zoom hard out then hard in                                                                                                                                                      | 1.5 px/bar floor (whole project on screen) up to 1200 px/bar (sample-editor view).                  |
| B5  | Select clips → **← / →** nudge by one bar; **Shift+←/→** nudges 1/16. **Ctrl+G / Ctrl+Shift+G** group/ungroup — dragging one member moves the group. **Shift+L** locks (dashed, drag refuses). |

## C. Fades & crossfades (wave FC, schema v16)

| #   | Action                                                                | Expect                                                                      |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| C1  | Overlap two clips on one track, select range over them, press **X**   | Real crossfade over the overlap — no level dip in the middle (equal-power). |
| C2  | Two adjacent clips + **X**                                            | Short 0.08 s seams as before.                                               |
| C3  | Audio menu of a clip → **FADE CURVE → Equal power**, drag a long fade | Smooth power-preserving ramp; toggle back to Linear for the old behavior.   |

## D. Regression sanity (older waves)

- Split a clip → both fragments ≥ 1 bar, left-trim via the left 10 px zone of a **scene clip**.
- Ctrl+D duplicates a time range; arrangement clips refuse overlap with a toast (not silence).
- Undo ×5 / Redo ×5 after any of the above — exact restoration, no orphan clips.

---

## Deployed smoke (needs the real URL)

```bash
KYX_DEPLOY_URL=https://<your-deploy> npm run release:deployed-smoke
```

Optional collab checks: `KYX_COLLAB_URL`, `KYX_ALLOWED_ORIGIN`, `KYX_GALLERY_PUBLIC=1 KYX_GALLERY_ADMIN_TOKEN=<token>`.
Without a collab URL the static app checks still run and server checks are marked skipped.
