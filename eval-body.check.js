
  (async () => {
  const wav = await import("/src/rendering/wav.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
  const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
  const { FACTORY_PRESETS, GOLDEN_PRESET_IDS, SCENE_PRESET_IDS } = await import(
    "/src/effects/morph-dynamics-core/presets/factoryPresets.ts"
  );
  const { defaultParamsOf } = await import("/src/effects/registry.ts");
  const { normalizeIntent } = await import("/src/intent/normalize.ts");
  const { planGeneration } = await import("/src/intent/plan.ts");
  const { generatePattern } = await import("/src/ai/generator.ts");
  const { getStyleNamesForGenre } = await import("/src/ai/grooves/index.ts");
  const { roleForTrack, MELODIC_NOTES_CAP } = await import("/src/intent/favorites.ts");

  const bank = await generateFactoryBank();

  const encode = (buffer) => {
    const bytes = new Uint8Array(wav.encodeWav(buffer, 16));
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(binary);
  };

  const renderDoc = async (doc) => {
    try {
      const buffer = await renderer.renderProject(doc, bank, {
        mode: "pattern",
        sampleRate: 44100,
        tailSeconds: 0.8,
      });
      return encode(buffer);
    } catch (err) {
      console.log(
        "[room] FAIL",
        err.message,
        "|",
        String(err.stack || "").split("\n").slice(0, 4).join(" ~~ "),
      );
      throw err;
    }
  };

  const withMorphOnDrums = (templateId, presetParams) => {
    const doc = createProjectFromTemplate(templateId);
    const drums = doc.tracks.find((t) => t.kind === "drum");
    const fx = {
      id: "fx-morph-room",
      type: "morphdynamics",
      bypassed: false,
      params: { ...defaultParamsOf("morphdynamics"), ...presetParams },
    };
    doc.tracks = doc.tracks.map((t) =>
      t.id === drums.id ? { ...t, effects: [...(t.effects ?? []), fx] } : t,
    );
    return doc;
  };

  const out = { morph: [], scenes: [], intent: [] };

  // ── suite: morph (8 GOLDEN × 2 paths + shared bypass) ──────────────────
  const morphBase = createProjectFromTemplate("house");
  out.morph.push({ id: "bypass", label: "BYPASS", paths: { drums: await renderDoc(morphBase) } });
  for (const id of GOLDEN_PRESET_IDS.filter(Boolean)) {
    const preset = FACTORY_PRESETS.find((p) => p.id === id);
    if (!preset) continue;
    const entry = { id: preset.id, label: preset.label, category: preset.category, description: preset.description ?? "", paths: {} };
    for (const pathKind of ["drums", "808"]) {
      const doc = createProjectFromTemplate("house");
      const trackId =
        pathKind === "drums"
          ? doc.tracks.find((t) => t.kind === "drum").id
          : doc.tracks.find((t) => t.kind === "instrument").id;
      const fx = {
        id: "fx-morph-" + pathKind,
        type: "morphdynamics",
        bypassed: false,
        params: { ...defaultParamsOf("morphdynamics"), ...preset.params },
      };
      doc.tracks = doc.tracks.map((t) =>
        t.id === trackId ? { ...t, effects: [...(t.effects ?? []), fx] } : t,
      );
      entry.paths[pathKind] = await renderDoc(doc);
    }
    out.morph.push(entry);
  }

  // ── suite: scenes (4 genre presets on their OWN genre beats) ───────────
  const scenePairs = [
    { presetId: "morph-drill-bus-pressure", templateId: "drill" },
    { presetId: "morph-phonk-808-weight", templateId: "phonk" },
    { presetId: "morph-jersey-vocal-bark", templateId: "jersey" },
    { presetId: "morph-dnb-punch-glue", templateId: "dnb" },
  ];
  for (const pair of scenePairs) {
    const preset = FACTORY_PRESETS.find((p) => p.id === pair.presetId);
    if (!preset) continue;
    const dry = createProjectFromTemplate(pair.templateId);
    const bypass = await renderDoc(dry);
    const wet = withMorphOnDrums(pair.templateId, preset.params);
    const wetAudio = await renderDoc(wet);
    out.scenes.push({
      id: preset.id,
      label: preset.label,
      templateId: pair.templateId,
      description: preset.description ?? "",
      bypass,
      wet: wetAudio,
    });
  }

  // ── suite: intent (3 ranker groups × 4 dataset-compatible candidates) ──
  // groupKey/seed EXACTLY match scripts/generate-intent-ranker-dataset.mts,
  // so ranking verdicts ingest straight into intent-ranker-golden.json.
  const doc0 = createProjectFromTemplate("house");
  const GROUPS = [
    { genre: "drill" },
    { genre: "house" },
    { genre: "trap" },
  ];
  for (const group of GROUPS) {
    const styles = getStyleNamesForGenre(group.genre);
    const style = (styles[0] ?? "basic").toLowerCase().replace(/\\s+/g, "");
    const groupKey = group.genre + ":" + style + ":ds-" + group.genre + "-" + style + "-0";
    const candidates = [];
    for (let seedIndex = 0; seedIndex < 4; seedIndex++) {
      const seed = "ds-" + group.genre + "-" + style + "-" + seedIndex;
      const intent = normalizeIntent({
        genre: group.genre,
        style,
        energy: 0.3 + ((seedIndex * 13) % 7) / 10,
        density: 0.3 + ((seedIndex * 7) % 7) / 10,
        complexity: 0.2 + ((seedIndex * 11) % 8) / 10,
        variation: 0.2 + ((seedIndex * 17) % 8) / 10,
        seed,
        roles: ["drums", "bass"],
        candidateCount: 4,
      });
      const plan = planGeneration(intent, doc0);
      const generation = generatePattern(doc0, plan.options);
      // generatePattern returns a bare pattern — inherit the template's
      // playback mode (tempo map reads pattern.mode.bpm at render time).
      const pattern = { ...generation.pattern, mode: generation.pattern.mode ?? doc0.patterns[0]?.mode };
      const audio = await renderDoc({
        ...doc0,
        patterns: [pattern],
        activePatternId: pattern.id,
      });
      // FavoriteLedgerEntry shape (mirrors DiceContext) — enables
      // favorites:retrain (all three learned models) from ★ verdicts.
      const drumTrack = doc0.tracks.find((t) => t.kind === "drum");
      const melodic = [];
      let noteCount = 0;
      const instrumentTracks = doc0.tracks.filter((t) => t.kind === "instrument");
      for (const [trackIndex, track] of instrumentTracks.entries()) {
        const notes = (pattern.notes ?? {})[track.id] ?? [];
        if (notes.length === 0 || noteCount >= MELODIC_NOTES_CAP) continue;
        const role = roleForTrack(track.name, trackIndex);
        if (!role) continue;
        melodic.push({
          role,
          trackName: track.name,
          notes: notes.slice(0, MELODIC_NOTES_CAP - noteCount).map((n) => ({
            pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity,
          })),
        });
        noteCount += melodic.reduce((sum, m) => sum + m.notes.length, 0);
      }
      candidates.push({
        seed,
        index: seedIndex,
        audio,
        favorite: {
          savedAt: Date.now(),
          seed,
          genre: group.genre,
          grooveId: String(generation.grooveId ?? ""),
          energy: intent.energy,
          density: intent.density,
          complexity: intent.complexity,
          variation: intent.variation,
          padIds: drumTrack.pads.map((p) => p.id),
          padNames: drumTrack.pads.map((p) => p.name),
          rows: JSON.parse(JSON.stringify(pattern.rows)),
          length: generation.stepCount,
          style: generation.style ?? null,
          ghostWeight: generation.ghostWeight,
          microWeight: generation.microWeight,
          velocityVariation: generation.velocityVariation,
          temperature: generation.temperature,
          key: doc0.key ?? intent.key ?? null,
          melodic,
        },
      });
    }
    out.intent.push({ groupKey, genre: group.genre, style, candidates });
  }

  return out;
  })()
  