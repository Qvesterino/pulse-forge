import io

def patch(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert old in s, f"{path}: anchor not found: {old[:70]!r}"
        assert s.count(old) == 1, f"{path}: anchor not unique: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(path, "w", encoding="utf-8", newline="\n").write(s)
    print(f"patched {path} ({len(pairs)} edits)")

# ── studio-words.ts ─────────────────────────────────────────────────────────
patch("src/intent/studio-words.ts", [
    (
        "(?:undo|vr[aá]ť(?:\\s+to)?|vrath?ni|sp[aä]ť(?:\\s+to)?|step\\s+back)",
        "(?:undo|vr[aá]ť(?:\\s+to)?|vrath?ni|sp[aä]ť(?:\\s+to)?|krok\\s+sp[aä]ť|step\\s+back)",
    ),
    (
        "ako|aky|ak[áá]|v akom|kolko",
        "ako|aky|ake|akej|ak[áá]|v akom|kolko",
    ),
    (
        '  [/\\bkey\\b|\\btonina\\b/i, "key"],',
        '  [/\\bkey\\b|\\btonina\\b|\\bkluc\\b|k\\u013e\\u00fa\\u010d/i, "key"],',
    ),
])

# ── loudness.ts ─────────────────────────────────────────────────────────────
patch("src/intent/loudness.ts", [
    (
        "const isLouder = /\\bmake it louder\\b|\\blouder\\b|\\bmore loud\\b|\\bhlas(?:it|ie|ej)/.test(lower);",
        "const isLouder = /\\bmake it louder\\b|\\blouder\\b|\\bmore loud\\b|\\bhlas(?:it|ie|ej|n)/.test(lower);",
    ),
])

# ── arrangeWords.ts ─────────────────────────────────────────────────────────
patch("src/intent/arrangeWords.ts", [
    (
        "move: /\\b(move|shift|push|posun)/,",
        "move: /\\b(move|shift|push|posun|presun)/,",
    ),
])

# ── production.ts ───────────────────────────────────────────────────────
patch("src/intent/production.ts", [
    (
        'export function parseProductionIntent(text: string): ProductionIntent | null {
  const lower = text.toLowerCase();',
        'export function parseProductionIntent(text: string): ProductionIntent | null {
  // Deaccented once here: every SK stem below is ASCII, so "hlbšiu" and
  // "hlbsiu" (keyboards differ) hit the same pattern.
  const lower = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");',
    ),
    (
        r"/hlbš(ia|í|ie|ý|íu|iu)?(?![a-z0-9])/",
        r"/hlbs(ia|i|ie|y|u|iu)?(?![a-z0-9])/",
    ),
    (
        r"/svetlejš(ia|í|ie|ý|íu|iu)?(?![a-z0-9])/",
        r"/svetlejs(ia|i|ie|y|u|iu)?(?![a-z0-9])/",
    ),
    (
        r"/jasnejš(ia|í|ie|ý|íu|iu)?(?![a-z0-9])/",
        r"/jasnejs(ia|i|ie|y|u|iu)?(?![a-z0-9])/",
    ),
    (
        r"(?:^|[^a-z0-9])[sš]ir[sš](ia|í|ie|ý|íu|iu)?(?![a-z0-9])",
        r"(?:^|[^a-z0-9])sirs(ia|i|ie|y|u|iu)?(?![a-z0-9])",
    ),
    (
        r"/grittier/",
        r"/grittier|tazs(ia|i|ie|y|u|iu)?/",
    ),
])

# ── complaints.ts ───────────────────────────────────────────────────────────
patch("src/intent/complaints.ts", [
    (
        'export function parseComplaintIntent(text: string): ComplaintIntent | null {\n  let complaint: ComplaintKind | null = null;',
        'export function parseComplaintIntent(text: string): ComplaintIntent | null {\n  // Deaccented once: keyboards differ ("mŕtvy" vs "mrtvy") and the new\n  // stems are ASCII; the legacy [áa]-style alternations keep matching the\n  // deaccented input.\n  const plain = text\n    .toLowerCase()\n    .normalize("NFD")\n    .replace(/[\\u0300-\\u036f]/g, "");\n  let complaint: ComplaintKind | null = null;',
    ),
    (
        "  for (const [re, kind] of COMPLAINT_WORDS) {\n    if (re.test(text)) {",
        "  for (const [re, kind] of COMPLAINT_WORDS) {\n    if (re.test(plain)) {",
    ),
    (
        "[/\\b(?:thin|weak|tenk[\u00fd\u00fd]\\w*|chud[\u00fdy]\\w*|slab[\u00fdy]\\w*)\\b/i, \"thin\"],",
        "[/\\b(?:thin|weak|tenk\\w*|chud\\w*|slab\\w*)\\b/i, \"thin\"],",
    ),
    (
        "[/\\bmuddy\\b|\\bblato\\b|\\bbahnist\\w*|\\bkaln\\w*/i, \"muddy\"],",
        "[/\\bmuddy\\b|\\bblat[oi]?\\b|\\bblat[ai]st\\w*|\\bbahnist\\w*|\\bkaln\\w*|\\bzamuten\\w*|\\bdut\\w*|\\bhukot/i, \"muddy\"],",
    ),
    (
        "[/\\bharsh\\b|\\bpiercing\\b|\\bostr[\u00fdy\u00e1]\\w*|\\bdr[\u00e1\u00e1]\u017e\\w*|\\bpich[\u00e1a]\\b/i, \"harsh\"],",
        "[/\\bharsh\\b|\\bpiercing\\b|\\bostr\\w*|\\bdraz\\w*|\\bpicha\\b|\\bkrici\\b|\\bskrece\\b|\\bbodav/i, \"harsh\"],",
    ),
    (
        "[/\\bno\\s+punch\\b|\\bbez\\s+razanc\\w*|\\bno\\s+knock\\b|\\bm[\u00e4a]kk[\u00e9e]\\w*\\s+drums\\b/i, \"noPunch\"],",
        "[/\\bno\\s+punch\\b|\\bbez\\s+razanc\\w*|\\bno\\s+knock\\b|\\bmakk\\w*\\s+drums\\b|\\bmrtv\\w*|\\bbez\\s+uder\\w*|\\bchyba\\s+uder\\w*/i, \"noPunch\"],",
    ),
    (
        "[/\\b(?:empty|void|pr[\u00e1a]zdn\\w*)\\b/i, \"empty\"],",
        "[/\\b(?:empty|void|prazdn\\w*)\\b|\\bnic\\s+sa\\s+nedeje/i, \"empty\"],",
    ),
    (
        "  const role = ROLE_WORDS.find(([re]) => re.test(text))?.[1] ?? null;\n  const family = TARGET_WORDS.find(([re]) => re.test(text))?.[1] ?? null;",
        "  const role = ROLE_WORDS.find(([re]) => re.test(plain))?.[1] ?? null;\n  const family = TARGET_WORDS.find(([re]) => re.test(plain))?.[1] ?? null;",
    ),
])
print("ALL PATCHES APPLIED")
