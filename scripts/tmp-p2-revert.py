import io
import subprocess

def patch(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert old in s, f"{path}: anchor not found: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(path, "w", encoding="utf-8", newline="\n").write(s)
    print(f"reverted {path}")

# 1. model-schema.ts — the ONLY grammar-breaking file: remove kind + vocab + spec
patch("src/intent/model-schema.ts", [
    ('    "effectIntent",\n    "paramIntent",\n', '    "effectIntent",\n'),
    (
        '  paramRole: ["mix", "time", "tone", "drive", "width"] as const,\n',
        "",
    ),
    (
        '''  // Param wave P2: a NAMED KNOB (non-primary) \u2014 role is the closed enum,
  // the engine maps role -> paramId per effect. mode set carries an absolute
  // raw value; more/less carry the vibe ladder or an explicit percent.
  paramIntent: {
    slots: [
      E("effect", VOCAB.effectType),
      E("role", VOCAB.paramRole),
      EA("targets", VOCAB.mixTarget),
      E("mode", ["set", "more", "less"]),
      I("value", 0, 100000, false),
      I("percent", 0, 100),
    ],
  },
''',
        "",
    ),
])

# 2. trainer — remove KINDS entry, constants, labels, heads
patch("scripts/train-intent-model.py", [
    ('    "effectIntent",\n    "paramIntent",\n', '    "effectIntent",\n'),
    (
        '# Param wave P2 (src/intent/param-intent.ts PARAM_ROLES + model-schema VOCAB)\nPARAM_ROLES = ["mix", "time", "tone", "drive", "width"]\nPARAM_MODES = ["set", "more", "less"]\n',
        "",
    ),
    (
        '''    # Param wave P2 \u2014 flat compact record (kind, effect, role, targets, mode\u2026)
    labels["paramEffect"] = as_class(response.get("effect") if kind == "paramIntent" else None)
    labels["paramRole"] = as_class(response.get("role") if kind == "paramIntent" else None)
    labels["paramMode"] = as_class(response.get("mode") if kind == "paramIntent" else None)
    note("paramValue", response.get("value") if kind == "paramIntent" else None)
    labels["paramValue"] = as_class(response.get("value") if kind == "paramIntent" else None)
    note("paramPercent", response.get("percent") if kind == "paramIntent" else None)
    labels["paramPercent"] = as_class(response.get("percent") if kind == "paramIntent" else None)
''',
        "",
    ),
    (
        '''        {"name": "paramEffect", "kind": "softmax", "classes": [ABSENT] + EFFECT_TYPES},
        {"name": "paramRole", "kind": "softmax", "classes": [ABSENT] + PARAM_ROLES},
        {"name": "paramMode", "kind": "softmax", "classes": [ABSENT] + PARAM_MODES},
        {"name": "paramValue", "kind": "softmax", "classes": [ABSENT] + sorted({v for v in numeric_field_values(rows, "paramValue")}, key=float)},
        {"name": "paramPercent", "kind": "softmax", "classes": [ABSENT] + sorted({v for v in numeric_field_values(rows, "paramPercent")}, key=float)},
''',
        "",
    ),
])

# 3. corpus generator — drop the param + contrast families (they would be
# unsupported-dropped without the schema entry; keep the generator honest)
s = io.open("scripts/generate-intent-dataset.mts", encoding="utf-8").read()
start = s.find("  // \u2500\u2500 PARAM WAVE P2 (2026-10-14)")
end = s.find("  return [\n    { lang: \"en\", instructions: en },")
assert 0 < start < end
s = s[:start] + s[end:]
io.open("scripts/generate-intent-dataset.mts", "w", encoding="utf-8", newline="\n").write(s)
print("corpus families removed")

# 4. verify the grammar hash matches the shipped manifest again
out = subprocess.run(
    ["git", "diff", "--stat", "src/intent/model-schema.ts"], capture_output=True, text=True
).stdout.strip()
print("schema diff after revert:", out or "CLEAN (matches HEAD = shipped grammar)")
