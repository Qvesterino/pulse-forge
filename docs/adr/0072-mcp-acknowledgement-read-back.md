# ADR 0072 — The acknowledgement is read back from the committed document

Date: 2026-10-27 · Status: Accepted (shipped) · Scope: MCP surface, R-02 verification gate

## Context

Two findings in the audit (F-24 and S-1 gap 3) describe the same seam from two sides: **the answer
about a change was computed somewhere other than where the change happened.**

**F-24 — the handler's own chain.** `kyx_automation` built the document it _intended_ to write
(`next = addAutomationPoint(next, …).execute(next)`) and then reported the point from that local
chain — its value, its clamp note, its point count — without ever looking at the document the
project actually holds. The surface already had the right pattern elsewhere: `addRamp`, `movePoint`
and `kyx_plugin_param` re-read the committed document after `ctx.execute` and report from it. The
`addPoint` branch did not, and neither did `deletePoint`, `clearLane` or `removeLane`.

The gap is not academic. The document is written by the command layer, the normaliser and (in a
collab session) a merge — so the committed value can differ from the handler's intent: the
normaliser may clamp further than the command did, and a point may simply not land. In that case the
tool reported a point that was not there, at a value the document never held.

**S-1 gap 3 — the gate's read-back.** The R-02 gate appends its structural verification to
`result.text` only. `result.data` was left untouched when `mutated` did not change, so a client that
reads the structured answer — the whole point of the receipt envelope — saw `"status": "applied"`
with nothing in it that proved anything.

## Decision

### 1. The handler reads the committed document back

Every mutating branch of `kyx_automation` now re-reads the document after `ctx.execute` and reports
**from that**:

- `addPoint` — the lane and the point come from the committed document; the value, the clamp note
  and the point count are the committed ones. If the point is not in the committed lane, the answer
  is `PARTIAL_FAILURE`, not a point that was never there.
- `deletePoint` — if the committed lane still holds the point, the answer is `PARTIAL_FAILURE`.
- `clearLane` — if the committed lane still holds points, `PARTIAL_FAILURE`.
- `removeLane` — if the committed document still holds the lane, `PARTIAL_FAILURE`.

Each of them also carries a structured `data` (status, lane, the committed point, a `readback`
line) so the answer is readable without the prose.

### 2. The gate's read-back rides in the envelope

The gate's structural summary now also lands in `data.readback` — **for the tools whose output
schema declares that slot**. The receipt envelope already declares `readback: string[]`, so the
mirror lands in the vocabulary that exists.

The condition is deliberately narrow: the schema must **declare** the slot. A tool with a strict
schema (`OUTPUT_TAKES` has `additionalProperties: false`) has no such slot, and a key the schema
does not declare makes the structured content **invalid** — the mirror would trade one divergence
for another. A tool that produces its own precise `data` (status, counts, its own read-back) is
already self-verifying; mixing the gate's structural summary into that payload would blur two
vocabularies in one object.

## Consequences

- **The answer and the document can no longer disagree.** The tool's claim is derived from the
  document at the moment it claims it, which is the same rule the command layer and the store
  follow (one intent → one authoritative transition → consistent observable representations).
- **A change that did not land is now visible.** `PARTIAL_FAILURE` says "the command ran, the
  result is not what you asked for" — which is exactly the case the old code reported as success.
- **The receipt envelope is complete.** `data.readback` now carries the same verification the prose
  does, so a structured client does not have to parse English to know that something was verified.
- **`kyx_automation` results are richer.** The four mutating branches now return `data` with the
  committed lane, the committed point and a read-back line. That is an additive change to the
  envelope; the prose keeps its wording.

## Alternatives rejected

- **Report the local chain and let the client re-read.** Rejected: it asks every client to
  reimplement the read-back, and the whole point of the R-02 gate is that the surface checks the
  document rather than trusting the handler's account.
- **Mirror the read-back into `data` for every tool.** Rejected: it breaks the strict schemas
  (`additionalProperties: false`) and mixes the gate's structural summary into tools' own precise
  payloads.
- **Compare revisions instead of re-reading the document.** A revision number cannot say _what_ the
  committed value is; the acknowledgement needs the value itself.
