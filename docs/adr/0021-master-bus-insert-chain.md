# ADR 0021: Dedicated master-bus insert chain and delivery contract

Date: 2026-10-06 · Status: Accepted · Scope: project model, audio engine, mastering, export

## Context

KYX already has a fixed master chain and can place ZENIT or other effects on a
group bus. A mastering workspace needs a project-level delivery target and a
dedicated processor rack on the final stereo bus. Treating a group bus as the
master would leave the returns and other groups outside that processor path.

Delivery targets also diverged between the MIX meter and MCP. MIX stored a
LUFS target and compared true peak with the limiter ceiling; MCP used separate
profile limits and stricter loudness verdict bands. A project must carry one
delivery choice so the live meter, offline report, and assistants evaluate the
same target.

## Decision

1. `MasterConfig` owns the selected delivery profile, integrated-LUFS target,
   true-peak delivery target, and an ordered master effect list. These are
   serializable project state, edited through commands, normalized on load,
   and mirrored through collaboration.
2. Built-in delivery profiles are editable starting points. They do not claim
   platform certification or change audio processing. `Custom` preserves a
   user's own loudness and true-peak values. The physical limiter ceiling stays
   a separate processing control.
3. A dedicated master insert rack sits after the built-in glue stage and
   before the built-in clipper and look-ahead limiter. The final limiter stays
   last as output protection. Device order and bypass follow the normal effect
   rack rules and use the same effect runtimes in live playback and offline
   rendering.
4. Master inserts process the final stereo sum, including returns and all
   groups. ZENIT remains a track/group effect; a group-hosted ZENIT shapes
   that group before it joins the final sum. Track and group inserts remain
   available for stem shaping. Grouped-stem and per-track exports preserve the
   selected source's track/group processing and routed return processing, but
   bypass the complete global master chain. Exported stems clear source mute
   and solo flags so a live mix state cannot silently produce a partial stem.
   The full-mix master render honors the project's active mix/routing state
   and is the only path in the MASTER workspace that presents the
   master-delivery report.
5. Master inserts use the generic effect runtime, lazy worklet loading,
   parameter validation, and teardown path. Their latency is reported by the
   engine; because the insert is after the final sum, it does not need to
   offset one source against another. The monitor-only raw bypass branch is
   delayed by the reported pre-limiter latency of the built-in and inserted
   master processors before it rejoins the shared limiter. If reported latency
   exceeds the DelayNode alignment range, the MASTER signal-flow view reports
   that alignment is partial. Render tail and reported latency remain part of
   the offline-render acceptance checks.
6. Shared pure delivery rules define loudness tolerance, true-peak tolerance,
   and available stereo checks. MIX, export, and MCP consume those rules. A
   measurement report must distinguish measured values from target guidance.

## Consequences

- Bump the project schema and migrate older projects by mapping the former
  −14 LUFS default to Streaming, other former loudness values to Custom, and
  the former limiter ceiling to the new delivery true-peak target. This keeps
  their verdict behavior stable.
- New projects use the Streaming starting point (−14 LUFS, −1 dBTP), matching
  Spotify's current public mastering guidance as checked on 2026-10-06. The
  app describes it as a starting point because services and delivery briefs
  can differ. Other profiles are generic producer workflows, not published
  platform specifications.
- The rack is project-global and follows the master bus in both realtime and
  offline graphs. Existing track/group effect state and solo rules do not
  change.
- Codec-specific post-encode analysis and externally supplied stereo mixes
  remain separate roadmap work; neither can be implied by a pre-encode render
  report.

## Validation contract

- Migration preserves old loudness targets and ceilings.
- Profile verdicts match in the live meter, offline export summary, and MCP.
- Live and offline renders use identical master insert order and parameters.
- Reordering, bypass, parameter edits, undo/redo, collaboration round-trip,
  and project reopen preserve the serialized chain.
- Monitor bypass crossfades between paths aligned to the same reported
  pre-limiter processor latency; an alignment-range fallback is visible.
- Pre-master/stem output does not accidentally include master inserts.
- The final clipper/limiter stays downstream of all master inserts.

## Sources

- Spotify, [Loudness normalization](https://support.spotify.com/artists/article/loudness-normalization/),
  accessed 2026-10-06. Spotify describes −14 LUFS as its playback normalization
  reference and recommends true peak below −1 dBTP for lossy encoding, and
  below −2 dBTP when the master is louder than −14 LUFS. KYX surfaces the
  conditional limit as an advisory; these remain Spotify recommendations, not
  universal delivery requirements.
