# MORPH DYNAMICS — INTERACTION MODEL

## 1. UX Thesis

MORPH DYNAMICS contains a sophisticated reactive engine, but it must not feel like operating a laboratory before making music.

The interaction model uses progressive disclosure:

1. **Perform** — immediate macro controls
2. **Shape** — module-level controls
3. **Route** — modulation relationships
4. **Inspect** — analysis and diagnostics

The default view should be musically useful without opening deeper layers.

## 2. Primary Surface

The central visual anchor is **PRESSURE**.

Around it sit the primary musical dimensions:

- PUNCH
- BODY
- TEXTURE
- MOTION
- SPACE

Conceptual layout:

```text
                 PUNCH
                   |
        BODY -- PRESSURE -- TEXTURE
               /       \
           MOTION      SPACE
```

This is conceptual, not a strict visual specification.

## 3. PRESSURE

PRESSURE represents the depth of the reactive transformation.

It must feel continuous and useful throughout its range.

It should simultaneously influence multiple internal mappings, but those mappings are preset-aware and curated.

### User Expectation

Turning PRESSURE clockwise should make the plugin react more strongly to the performance, not simply make it louder, wetter or more distorted.

### Visual Feedback

The control should show:

- base value
- instantaneous reactive activity
- peak/recent activity where useful

The visual should communicate that PRESSURE is alive without becoming distracting.

## 4. PUNCH

PUNCH controls the treatment of attacks.

Negative/low behavior may produce softer, denser attacks.

Positive/high behavior should preserve or emphasize attack clarity.

PUNCH may internally influence:

- detector timing
- transient weighting
- transient parallel path
- saturation exposure
- space ducking

The user should not need to understand those implementation details.

## 5. BODY

BODY controls how sustained tonal mass responds.

Potential perceptual results:

- density
- warmth
- harmonic weight
- sustain cohesion
- controlled compression

BODY is not a simple low-mid EQ control.

## 6. TEXTURE

TEXTURE controls treatment of noisy/diffuse content.

Potential results:

- breath enhancement or restraint
- cymbal detail
- air
- diffusion
- width
- residual ambience

TEXTURE must avoid becoming synonymous with “treble.”

## 7. MOTION

MOTION controls reactive movement.

It can influence:

- phaser depth
- all-pass movement
- stereo motion
- modulation filtering
- movement feedback

At low values, motion should be nearly subliminal. At high values it can become a creative effect.

## 8. SPACE

SPACE controls the reactive spatial dimension.

It may influence:

- ambience send
- diffusion
- width
- reverb size
- decay
- transient ducking behavior

SPACE should be able to create the signature pattern:

> clear event → expanding tail

## 9. Module View

Opening a primary dimension reveals its relevant module controls.

Example Character/Body view:

```text
Drive
Color
Harmonics
Clip
Dynamics Response
```

Example Space view:

```text
Send
Pre-delay
Diffusion
Decay
Width
Transient Duck
```

Do not expose every internal coefficient.

## 10. Modulation Interaction

Every modulatable control should communicate two values:

1. its base value
2. its current modulated value

Recommended visualization:

- primary knob/value
- surrounding modulation arc/ring
- animated current-position indicator

The user should be able to glance at a control and understand that it is moving because of reactive modulation.

## 11. Route Creation

Advanced users need fast route creation.

Possible interaction:

1. enter Route mode
2. drag a source such as TRANSIENT onto a destination such as SPACE SEND
3. drag outward/inward to set amount
4. choose polarity/curve if needed

Alternative interaction patterns can be tested, but route creation must remain direct and visual.

## 12. Route Representation

A route exposes:

- source
- destination
- amount
- polarity
- curve
- attack/release override when needed

Example:

```text
TRANSIENT -> Space Send      -62%
BODY      -> Drive           +38%
TEXTURE   -> Width           +44%
GR        -> Motion Depth    +21%
```

The common workflow should not require editing all route properties.

## 13. Source Meters

TRANSIENT, BODY and TEXTURE should each have continuously readable activity meters.

The meters are essential because they teach the user the engine's mental model.

A producer should quickly learn:

> “That snare is lighting up Transient.”
>
> “The vocal sustain is feeding Body.”
>
> “The breath and cymbals are driving Texture.”

## 14. Advanced Analysis View

Optional advanced view may show:

- input envelope
- gain reduction
- transient score
- body score
- texture score
- density
- stereo correlation
- spectral activity

This is diagnostic and educational, not the default production surface.

## 15. A/B and State Comparison

Provide rapid comparison:

- A/B states
- copy A → B / B → A
- undo/redo
- temporary bypass
- level-matched audition option if technically reliable

The plugin must make it easy to distinguish “better” from simply “louder.”

## 16. Input/Output Controls

Always accessible:

- Input
- Output
- Mix
- Bypass

Optional:

- Auto Gain
- Delta audition

Delta mode can be valuable for hearing what the processor changes, but must be implemented correctly.

## 17. Preset Browser

Preset browsing should be organized by **intent and source**, not only by genre.

Example hierarchy:

```text
VOCAL
  Clean Control
  Dense Lead
  Breath Bloom
  Aggressive

DRUMS
  Punch
  Glue
  Smash
  Texture

BASS
  Solid
  Harmonic
  Moving

SYNTH
  Animate
  Widen
  Morph

CREATIVE
  Pulse
  Melt
  Bloom
  Destroy
```

Genre tags can exist as secondary metadata.

## 18. Macro Locking

When changing presets, advanced users may want to preserve certain global values.

Potential lockable parameters:

- Input
- Output
- Mix
- Pressure

This can be deferred if necessary.

## 19. Accessibility and Precision

Requirements:

- keyboard parameter entry
- fine adjustment modifier
- reset-to-default gesture
- readable numeric values
- scalable UI
- sufficient contrast
- no meaning conveyed solely by color

## 20. Motion Design

The UI should feel reactive but calm.

Avoid:

- excessive particle effects
- decorative animation unrelated to audio
- meters with unreadable ballistic behavior
- constant visual movement at silence

Animation must communicate signal behavior.

## 21. Beginner Experience

A beginner should be able to:

1. load a preset
2. turn PRESSURE
3. adjust PUNCH/BODY/TEXTURE/MOTION/SPACE
4. level-match output
5. save the result

No routing knowledge required.

## 22. Expert Experience

An expert should be able to:

1. tune analysis sensitivity
2. inspect reactive sources
3. modify modulation routes
4. invert relationships
5. adjust response curves
6. tune individual DSP modules
7. create reusable presets

The expert workflow must extend the simple workflow rather than replace it.

## 23. UX Anti-Patterns

Do not turn MORPH DYNAMICS into:

- a wall of tiny knobs
- a node editor by default
- a DAW inside a plugin
- a modular synth requiring patching before sound
- an analyzer that happens to process audio

## 24. Signature Interaction

The signature demo should require almost no explanation:

1. play a vocal or drum loop;
2. set PRESSURE near zero;
3. gradually increase it;
4. watch Transient/Body/Texture activity;
5. hear character, motion and space increasingly respond to the performance.

If that interaction is compelling, the product thesis is visible and audible at once.
