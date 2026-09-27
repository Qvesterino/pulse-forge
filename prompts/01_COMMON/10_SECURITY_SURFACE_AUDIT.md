# Security Surface Audit

> Operating contract: [00_CORE/MASTER_DAW_HARDENING_PROMPT.md](../00_CORE/MASTER_DAW_HARDENING_PROMPT.md) — Purpose, 8-step operating loop, non-negotiable rules, required output.
> Materialize a standalone copy: `npm run prompts:build -- 01_COMMON/10_SECURITY_SURFACE_AUDIT.md`

## Audit-specific mission

Audit the DAW's realistic security boundaries without turning the exercise into theoretical threat theater.

Inspect file parsing, archive handling, project deserialization, IPC/native bridge calls, filesystem paths, URL/object URL usage, user-supplied text, HTML/SVG rendering, external links, browser APIs, plugin preset/state loading, command invocation, and any shell/process access.

Look for path traversal, unsafe deserialization, injection, unrestricted file access, trust of renderer-controlled IPC payloads, XSS, dangerous URL schemes, insecure temporary files, leaked secrets, and overly broad permissions.

Fix high-confidence vulnerabilities with narrow validation and least-privilege controls. Add regression tests for each fixed vector.
