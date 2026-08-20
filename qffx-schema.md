# QFFX Scorepack Schema

Version 1.0 — Pulse Forge exports `.scorepack` ZIP files following this specification.

## Package structure

```
project-name.scorepack
├── audio/
│   ├── project-name-master.wav   (24-bit PCM, 48 kHz)
│   ├── stems/
│   │   ├── project-name-drums.wav
│   │   ├── project-name-bass.wav
│   │   └── project-name-music.wav
│   └── cues/
│       ├── impact.wav
│       ├── riser.wav
│       └── (one-shot per marker type used)
├── score.json
├── markers.json
├── automation.json
├── intensity.json
└── README.md
```

## score.json

Top-level project metadata.

```json
{
  "version": "1.0",
  "project": {
    "name": "My Beat",
    "bpm": 124,
    "timeSignature": { "numerator": 4, "denominator": 4 },
    "key": "C major",
    "tags": ["trailer", "epic"],
    "durationBars": 24
  },
  "scenes": [
    {
      "id": "scene-abc",
      "name": "INTRO",
      "patternId": "pattern-xyz",
      "intensity": 0.4,
      "loop": false,
      "hasIntensityCurve": true
    }
  ],
  "markerCount": 3,
  "sceneAutomationCount": 1
}
```

## markers.json

Array of marker objects. Each marker has a `tick` position and the computed `seconds` from the BPM.

```json
[
  {
    "id": "marker-abc",
    "name": "Hit",
    "type": "drop",
    "tick": 15360,
    "seconds": 31.0,
    "linkedClipId": "clip-xyz",
    "cue": "factory.fx.impact",
    "customId": null
  }
]
```

Marker types with built-in cue mappings:

| type     | cue asset                  |
|----------|----------------------------|
| drop     | factory.fx.impact          |
| buildup  | factory.fx.riser           |
| riser    | factory.fx.riser           |
| impact   | factory.fx.impact          |
| cue      | (none)                     |
| custom   | (none unless overridden)   |

## automation.json

Contains both pattern-level and scene-level automation.

```json
{
  "pattern": [
    {
      "target": { "kind": "trackGain", "trackId": "track-abc" },
      "points": [
        { "tick": 0, "value": 1.0, "seconds": 0 },
        { "tick": 960, "value": 0.5, "seconds": 1.935 }
      ]
    }
  ],
  "scene": [
    {
      "sceneId": "scene-abc",
      "target": { "kind": "trackGain", "trackId": "track-xyz" },
      "points": [
        { "offset": 0, "value": 0.7 },
        { "offset": 1920, "value": 1.0 }
      ]
    }
  ]
}
```

Scene automation points use `offset` (ticks from scene start), not absolute ticks.

## intensity.json

Per-scene intensity scalars and optional time-varying curves.

```json
[
  {
    "sceneId": "scene-abc",
    "name": "BUILD",
    "intensity": 0.7,
    "curve": [
      { "offset": 0, "value": 0.4 },
      { "offset": 1920, "value": 0.95 }
    ],
    "loop": false
  }
]
```

## Key

| Field              | Unit       | Range         | Default |
|--------------------|-----------|---------------|---------|
| bpm                | beats/min | 20–300        | 124     |
| timeSignature      |           |               | 4/4     |
| key                |           |               | null    |
| intensity          | scalar    | 0.0–1.0       | 0.7     |
| marker.type        | enum      | drop/buildup/riser/impact/cue/custom | cue |
| marker.tick        | ticks     | ≥0            | 0       |

## Rendering notes

- All audio is 24-bit PCM at 48 kHz.
- Master and stems include a 2-second reverb/delay tail.
- Cue WAVs are short one-shots extracted directly from the factory bank.

---

*Created by Pulse Forge v1.0*
