# Mix proposal constraints: change provenance

The mix-preview proposal constraint enforcement and validation work in commit
`2fab4490b1e42703bc8d210c3843302a085e1cc2` was prepared in the AI-first
musical-proposal task and was included in that commit by a concurrent session
in the shared worktree. Its commit message describes the other session's audit.

The work comprises `src/intent/musical-proposal.ts`,
`src/intent/validate-musical-proposal.ts`, `src/mcp/mix-preview.ts`,
`src/mcp/tools.ts`, `src/ui/MixPreviewChipLazy.tsx`, generated
`desktop/mcp-tool-defs.cjs` and `server/mcp-core.mjs`, and the tests
`tests/musical-proposal.test.ts` and `tests/mix-proposal-constraints.test.ts`.
It adds constraint declarations and pre-render/pre-apply checks for mix
previews, validates the versioned proposal, and commits constrained previews
as the checked undoable delta. A declared audition range does not itself limit
writes. Constraints passed to `kyx_mix_idea` require preview mode.

Verification in the originating task: `npm run typecheck`, `npm run
format:check`, the six-file MCP gate (226 tests), and focused proposal,
preview, scope and UI tests passed. The full typecheck and formatting gate ran
against the shared checkout, which included concurrent in-flight work.
