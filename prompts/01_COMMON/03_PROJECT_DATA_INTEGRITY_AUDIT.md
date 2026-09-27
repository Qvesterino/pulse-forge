# Project Persistence & Data Integrity Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/03_PROJECT_DATA_INTEGRITY_AUDIT.md`

## Audit-specific mission

Audit project persistence as if project files are precious user assets.

Inspect save, save-as, autosave, serialization, deserialization, schema validation, migrations, media references, IDs, ordering, optional fields, defaulting, versioning, partial writes, atomic replacement, corrupted input, unknown future fields, and backwards compatibility.

Required invariants:
- saving then loading preserves semantically identical project state;
- no valid persisted entity becomes orphaned or duplicated;
- partial writes cannot replace a valid project with corrupt data;
- migrations are deterministic and idempotent where expected;
- malformed input fails safely with useful diagnostics;
- unknown or older project versions are handled intentionally.

Create round-trip, corruption, migration, and interruption tests where missing. Fix high-confidence integrity risks immediately.
