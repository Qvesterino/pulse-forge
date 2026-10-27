# ADR 0076 — A substitution is disclosed, never silent

Date: 2026-10-27 · Status: Accepted (shipped) · Scope: MCP surface (master A/B restore), effect-instance resolvers

> **ADR number.** This was drafted as 0074 and renumbered to keep it adjacent to ADR 0075 (this
> finding's sibling), which itself was renumbered from 0073 — a parallel session claimed 0073 for
> `0073-tsar-controlled-mutations.md` while the repairs were in flight.

## Context

Audit finding **F-08** (STATE_DIVERGENCE_HUNTER_REPORT.md §4/F-08): **a stale ordinal target silently
redirects a write to a different entity.**

The master A/B restore resolved its target like this:

```ts
const matchingDevices = track.effects.filter((fx) => fx.type === device.type);
const instance = matchingDevices.find((fx) => fx.id === device.fxId) ?? matchingDevices[device.instanceIndex ?? 0];
```

The fallback is legitimate in one case — the user deleted the device and added the same type again, so
the id is new but the slot is the same. It is a **silent redirect** in the other: the user deleted the
ZENIT and added a _different_ ZENIT, and the restore wrote the saved state onto the new one.

Two things made the redirect invisible:

1. **The acknowledgement named the SAVED ordinal.** The applied list was built from
   `device.instanceIndex` — the ordinal captured in the snapshot — while the write had landed on
   whatever the fallback resolved to. The label could therefore name a slot the write never touched.
2. **Nothing said so.** The answer read `restored 'snap' on Drums/zenit #2` — a plausible-looking
   success on the wrong entity. The AI had no way to learn that the instance it had captured no longer
   existed.

**A class measurement, first.** The report claimed the same `?? <ordinal>` shape also lived in the
effect-instance and automation-target resolvers. Measured against today's tree, it does **not**: the
reorder resolver, the automation-target resolver and the plugin-param resolver all resolve by id and
**refuse explicitly** when the id does not match (`UNKNOWN_TARGET`, an `unmatched` reason, no write).
The `?? <ordinal>` fallback existed in **exactly one place** — the A/B restore. One more candidate
(`src/integrations/audiotool-nexus/writer.ts`) requires **exactly one** match and declines otherwise, so
it never substitutes either.

So the class is: **one write path that can land on an instance the caller did not name.**

## Decision

### 1. The fallback stays — it is disclosed

The fallback is not removed: the "recreated the same device" case is real, and refusing it would be a
different lie. What changes is that the substitution is **named**.

The restore now records, for every device whose saved id did not survive:

- the **saved** instance (its label and its id) — what the snapshot captured;
- the **applied** instance (its label, its id, and its ordinal among the same-type instances that
  exist **now**) — where the write actually landed.

### 2. The acknowledgement names the instance it wrote to

The applied label is built from the **resolved** instance: its type, its ordinal among the same-type
instances that exist now, and its id. The saved ordinal is never used as a label for a write that did
not land there.

### 3. The disclosure rides in the prose AND in the structured data

The prose is what the AI reads, so the disclosure lives there:

> `restored 'snap' on Drums/zenit (fx-09f5…) — NOTE: 1 saved instance(s) no longer exist, so the write
landed on a DIFFERENT one: Drums/zenit [fx-d826…] → Drums/zenit (fx-09f5…)`

The receipt envelope carries the same fact as `data.substitutions[]` (`savedFxId`, `appliedFxId`,
`savedInstance`, `appliedInstance`), so a structured client does not have to parse English to know that
the write went somewhere else.

A restore that hits the saved instance discloses **nothing** — the note is not noise, it is a fact.

## Consequences

- **The answer and the document can no longer disagree.** The acknowledgement names the instance the
  write landed on, and says so when that is not the instance the caller captured.
- **A restore is still one undo step.** The disclosure adds no command, no undo entry and no write.
- **The one remaining ordinal fallback is pinned.** The gate counts the ordinal fallbacks in the MCP
  layer and asserts there is exactly **one** — the A/B restore's — and that it sits next to the
  disclosure. A second silent substitution cannot be added without failing the gate.
- **The typed contrast is pinned too.** The plugin-param resolver must keep refusing an unknown
  `fxId` without writing to another instance.

## Alternatives rejected

- **Remove the fallback and refuse when the saved id is gone.** Rejected: the "recreated the same
  device" case would become an error for a legitimate restore, and the report already named
  disclosure as the right minimum.
- **Disclose only in the structured data.** Rejected: the AI reads the prose. A fact that lives only
  in a field no one parses is not a disclosure.
- **Keep the saved ordinal as the label and add a note.** Rejected: the label would still name a slot
  the write did not land in — a plausible-looking success with a caveat attached, which is the shape of
  the defect itself.
- **Extend the repair to the type-addressed resolvers** (`kyx_master` iterate/assist pick the first
  instance of a type). Rejected as a different defect: those address by **type**, which is a declared
  address mode, and the ambiguity there is "which one did you mean", not "a write was redirected".
  Naming the resolved instance in their acknowledgements is a separate improvement, not this finding.

## Verification

- `tests/mcp-target-substitution.test.ts` (4 specs, new) — the restore discloses the substitution in the
  prose and in `data.substitutions`; a clean restore discloses nothing; the MCP layer holds exactly one
  ordinal fallback and it is the disclosed one; the plugin-param resolver still refuses an unknown id
  without writing.
