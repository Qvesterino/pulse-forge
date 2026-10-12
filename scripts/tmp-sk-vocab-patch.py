import io

def patch(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert old in s, f"{path}: anchor not found: {old[:70]!r}"
        assert s.count(old) == 1, f"{path}: anchor not unique: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(path, "w", encoding="utf-8", newline="\n").write(s)
    print(f"patched {path} ({len(pairs)} edits)")

# ── exact.ts ────────────────────────────────────────────────────────────────
patch("src/intent/exact.ts", [
    # transport: spusti/stopni join the bare-word vocabulary
    (
        r"(?:play|stop|pause|hraj|hrat|start|pauza|pauzu|zastav|stoj|",
        r"(?:play|stop|pause|hraj|hrat|start|spusti|pauza|pauzu|zastav|stoj|stopni|",
    ),
    # mute: SK "mutni/mutnúť"
    (
        r"const muteMatch = /\b(mute|st\u00eds|vypni)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);",
        r"const muteMatch = /\b(mute|st\u00eds|vypni|mutn\w*)\s+(?:the\s+)?([a-z-]+)\b/.exec(lower);",
    ),
    # pan: SK verb "panuj" + SK directions dolava/doprava (probe pins carry a
    # number; a bare direction stays declined by design — no guessed amount)
    (
        r"/pan\s+(?:the\s+)?([a-z-]+)\s*(?:to\s*)?(\d{1,3})\s*%?\s*(left|right|lavo|pravo)?/.exec(lower) ??",
        r"/pan(?:uj|ujte)?\s+(?:the\s+)?([a-z-]+)\s*(?:to\s*)?(\d{1,3})\s*%?\s*(left|right|lavo|pravo|dolava|doprava)?/.exec(lower) ??",
    ),
    (
        r"/pan\s+(?:the\s+)?([a-z-]+)\s*(left|right)\s*(\d{1,3})?/.exec(lower);",
        r"/pan(?:uj|ujte)?\s+(?:the\s+)?([a-z-]+)\s+(left|right|dolava|doprava)\s*(\d{1,3})?/.exec(lower);",
    ),
    (
        r"""    const directional = pan[2] === "left" || pan[2] === "right";""",
        r"""    const directional = ["left", "right", "dolava", "doprava"].includes(String(pan[2]));""",
    ),
    (
        r"""      if (dir === "left") value = -value;""",
        r"""      if (dir === "left" || dir === "dolava") value = -value;""",
    ),
    # SK transpose: count is OPTIONAL ("o oktavu" = one octave) + jeden/jednu
    (
        r"/(drums?|bass|bas\w*|808|lead|synth\w*|chords?|keys?|bic\w*)\b\s+o\s+(?<count>\d+|dva|tri|styri|pat|sest|sedem|osem|devat|desat)\s+(?<unit>ton\w*|semiton\w*|polton\w*|oktav\w*)\b\s+(?<dir>hore|dole|nizsie|vyssie)/.exec(",
        r"/(drums?|bass|bas\w*|808|lead|synth\w*|chords?|keys?|bic\w*)\b\s+o\s+(?<count>\d+|jeden|jednu|dva|tri|styri|pat|sest|sedem|osem|devat|desat)?\s+(?<unit>ton\w*|semiton\w*|polton\w*|oktav\w*)\b\s+(?<dir>hore|dole|nizsie|vyssie)/.exec(",
    ),
    (
        r"/posun\s+(drums?|bass|bas\w*|808|lead|synth\w*|chords?|keys?|bic\w*)\b\s+(?<dir>hore|dole|nizsie|vyssie)\s+o\s+(?<count>\d+|dva|tri|styri|pat|sest|sedem|osem|devat|desat)\s+(?<unit>ton\w*|semiton\w*|polton\w*|oktav\w*)\b/.exec(",
        r"/posun\s+(drums?|bass|bas\w*|808|lead|synth\w*|chords?|keys?|bic\w*)\b\s+(?<dir>hore|dole|nizsie|vyssie)\s+o\s+(?<count>\d+|jeden|jednu|dva|tri|styri|pat|sest|sedem|osem|devat|desat)?\s+(?<unit>ton\w*|semiton\w*|polton\w*|oktav\w*)\b/.exec(",
    ),
])

# ── conversation.ts ─────────────────────────────────────────────────────────
patch("src/intent/conversation.ts", [
    # tempo gate: "spomal to" — the word is spomal, not palom-prefixed
    (
        r"/\btempo\b|\bbpm\b|\bpomal|\brychl|",
        r"/\btempo\b|\bbpm\b|\bpomal|\bspomal|\brychl|",
    ),
    # punch nouns: compression IS the punch lane (drum comp + sat)
    (
        r"if (/\bpunch(?:ier|y)?\b|\bmore punch\b|\btighter\b|\brazantnejsi|\brazant/.test(lower)) {",
        r"if (/\bpunch(?:ier|y)?\b|\bmore punch\b|\btighter\b|\brazantnejsi|\brazant|\b(?:viac |more )?kompres|\bsquash/.test(lower)) {",
    ),
    (
        r'} else if (/\bsofter (?:drums|mix|hit)\b|\bmenej razant/.test(lower)) {',
        r'} else if (/\bsofter (?:drums|mix|hit)\b|\bmenej razant|\bmenej kompres|\bless compress/.test(lower)) {',
    ),
])

# ── route.ts — revise stems ─────────────────────────────────────────────────
patch("src/intent/route.ts", [
    (
        r"const REVISE_ENERGY_MORE = /\bmore (?:energetic|energic|energy)\b|\benergickejsi\b|\bviac (?:energie|energicky)\b/;",
        r"const REVISE_ENERGY_MORE = /\bmore (?:energetic|energic|energy)\b|\benergickejs|\bviac (?:energie|energicky)\b/;",
    ),
    (
        r"const REVISE_ENERGY_LESS = /\bless (?:energetic|energic|energy)\b|\bcalmer\b|\bmenej (?:energie|energicky)\b/;",
        r"const REVISE_ENERGY_LESS = /\bless (?:energetic|energic|energy)\b|\bcalmer\b|\bpokojnejs|\bmenej (?:energie|energicky)\b/;",
    ),
    (
        r"const REVISE_DENSITY_MORE = /\b(?:more )?(?:busier|denser)\b|\bhustejsi\b|\bviac prvkov\b/;",
        r"const REVISE_DENSITY_MORE = /\b(?:more )?(?:busier|denser)\b|\bhustejs|\bviac prvkov\b/;",
    ),
])

# ── studio-words.ts — undo + query ──────────────────────────────────────────
patch("src/intent/studio-words.ts", [
    (
        r"(?:undo|vr[aá]ť(?:\s+to)?|vrath?ni|sp[aä]ť(?:\s+to)?|step\s+back)",
        r"(?:undo|vr[aá]ť(?:\s+to)?|vrath?ni|sp[aä]ť(?:\s+to)?|krok\s+sp[aä]ť|step\s+back)",
    ),
    (
        r"/^\s*(?:what|which|how many|list|show|ako|aky|ak[áá]|v akom|kolko|koľko|zoznam|ukaz|co|čo)\b/i.test(text);",
        r"/^\s*(?:what|which|how many|list|show|ako|aky|ake|akej|ak[áá]|v akom|kolko|koľko|zoznam|ukaz|co|čo)\b/i.test(text);",
    ),
    (
        r"[/\\]\bkey\b|\btonina\b/i, \"key\"],",
        r"[/\\]\bkey\b|\btonina\b|\bkluc\b|\bk\u013e\u00fa\u010d/i, \"key\"],",
    ),
])

# ── loudness.ts — hlasn stem ────────────────────────────────────────────────
patch("src/intent/loudness.ts", [
    (
        r"const isLouder = /\bmake it louder\b|\blouder\b|\bmore loud\b|\bhlas(?:it|ie|ej)/.test(lower);",
        r"const isLouder = /\bmake it louder\b|\blouder\b|\bmore loud\b|\bhlas(?:it|ie|ej|n)/.test(lower);",
    ),
])

# ── arrangeWords.ts — presun ────────────────────────────────────────────────
patch("src/intent/arrangeWords.ts", [
    (
        r"move: /\b(move|shift|push|posun)/,",
        r"move: /\b(move|shift|push|posun|presun)/,",
    ),
])

# ── production.ts — deaccent + ASCII stems ──────────────────────────────────
patch("src/intent/production.ts", [
    (
        "export function parseProductionIntent(text: string): ProductionIntent | null {\n  const lower = text.toLowerCase();",
        "export function parseProductionIntent(text: string): ProductionIntent | null {\n  // Deaccented once here: every SK stem below is ASCII, so \"hlbšiu\" and\n  // \"hlbsiu\" (keyboards differ) hit the same pattern.\n  const lower = text\n    .toLowerCase()\n    .normalize(\"NFD\")\n    .replace(/[\\u0300-\\u036f]/g, \"\");",
    ),
    (
        r"/\bhlb\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/",
        r"/\bhlbs(ia|i|ie|y|u|iu)?(?![a-z0-9])/",
    ),
    (
        r"/\bsvetlej\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/",
        r"/\bsvetlejs(ia|i|ie|y|u|iu)?(?![a-z0-9])/",
    ),
    (
        r"/\bjasnej\u0161(ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])/",
        r"/\bjasnejs(ia|i|ie|y|u|iu)?(?![a-z0-9])/",
    ),
    (
        r"(?:^|[^a-z0-9])[s\u0161]ir[s\u0161](ia|\u00ed|ie|\u00fd|\u00edu|iu)?(?![a-z0-9])",
        r"(?:^|[^a-z0-9])sirs(ia|i|ie|y|u|iu)?(?![a-z0-9])",
    ),
    (
        r"/\bgrittier\b/",
        r"/\bgrittier\b|\btazs(ia|i|ie|y|u|iu)?\b/",
    ),
])

# ── complaints.ts ───────────────────────────────────────────────────────────
patch("src/intent/complaints.ts", [
    (
        "export function parseComplaintIntent(text: string): ComplaintIntent | null {\n  let complaint: ComplaintKind | null = null;",
        "export function parseComplaintIntent(text: string): ComplaintIntent | null {\n  // Deaccented once: keyboards differ (\"mŕtvy\" vs \"mrtvy\") and every stem\n  // below is ASCII; the legacy [áa]-style alternations keep matching the\n  // deaccented input.\n  const plain = text\n    .toLowerCase()\n    .normalize(\"NFD\")\n    .replace(/[\\u0300-\\u036f]/g, \"\");\n  let complaint: ComplaintKind | null = null;",
    ),
    (
        "  for (const [re, kind] of COMPLAINT_WORDS) {\n    if (re.test(text)) {",
        "  for (const [re, kind] of COMPLAINT_WORDS) {\n    if (re.test(plain)) {",
    ),
    (
        r"[/\\]\b(?:thin|weak|tenk[ýý]\w*|chud[ýy]\w*|slab[ýy]\w*)\b/i, \"thin\"],",
        r"[/\\]\b(?:thin|weak|tenk\w*|chud\w*|slab\w*)\b/i, \"thin\"],",
    ),
    (
        r"[/\\]\bmuddy\b|\bblato\b|\bbahnist\w*|\bkaln\w*/i, \"muddy\"],",
        r"[/\\]\bmuddy\b|\bblat[oi]?\b|\bblat[ai]st\w*|\bbahnist\w*|\bkaln\w*|\bzamuten\w*|\bdut\w*|\bhukot/i, \"muddy\"],",
    ),
    (
        r"[/\\]\bharsh\b|\bpiercing\b|\bostr[ýyá]\w*|\bdr[áá]ž\w*|\bpich[áa]\b/i, \"harsh\"],",
        r"[/\\]\bharsh\b|\bpiercing\b|\bostr\w*|\bdraz\w*|\bpicha\b|\bkrici\b|\bskrece\b|\bbodav/i, \"harsh\"],",
    ),
    (
        r"[/\\]\bno\s+punch\b|\bbez\s+razanc\w*|\bno\s+knock\b|\bm[äa]kk[ée]\w*\s+drums\b/i, \"noPunch\"],",
        r"[/\\]\bno\s+punch\b|\bbez\s+razanc\w*|\bno\s+knock\b|\bmakk\w*\s+drums\b|\bmrtv\w*|\bbez\s+uder\w*|\bchyba\s+uder\w*/i, \"noPunch\"],",
    ),
    (
        r"[/\\]\b(?:empty|void|pr[áa]zdn\w*)\b/i, \"empty\"],",
        r"[/\\]\b(?:empty|void|prazdn\w*)\b|\bnic\s+sa\s+nedeje/i, \"empty\"],",
    ),
    (
        "  const role = ROLE_WORDS.find(([re]) => re.test(text))?.[1] ?? null;\n  const family = TARGET_WORDS.find(([re]) => re.test(text))?.[1] ?? null;",
        "  const role = ROLE_WORDS.find(([re]) => re.test(plain))?.[1] ?? null;\n  const family = TARGET_WORDS.find(([re]) => re.test(plain))?.[1] ?? null;",
    ),
])
print("ALL PATCHES APPLIED")
