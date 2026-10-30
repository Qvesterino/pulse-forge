# Protected pattern proposals

Pattern generation can preserve roles from the active pattern, for example
`generate bass, keep drums` or `vytvor novú basu, bicie nechaj tak`. A proposal
with preservation carries a versioned `kyx.musical-proposal` pattern envelope:
project and revision, source, candidate pattern, declared protected paths,
source evidence and the outcome of structural checks. Audio quality and taste
are explicitly unmeasured. An in-memory iteration records its candidate source
instead of claiming that the source is already in the project.

Before offering the bank, auditioning, and applying, KYX checks the candidate
against the captured source and current project. Drum rows and step metadata
must match; preserved melodic notes must remain present. Track settings, tempo,
meter and global groove are protected as well. The command checks the concrete
write and refuses a changed project at execution. The optional artist mix and FX
are included in the preflight. A successful apply remains undoable.

The current generator resolves one track per protected role. If that resolution
is ambiguous or absent, KYX refuses the proposal and identifies the candidates;
it does not imply that every matching track was protected. Shared instrument
tracks can still receive generated notes for another requested role while all
original protected notes remain. In collaborative stores without a numerical
revision, the proposal reports freshness as unknown and the panel checks that
the source document snapshot is still current.
