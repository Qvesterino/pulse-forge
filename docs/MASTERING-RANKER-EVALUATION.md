# Mastering ranker evaluation

KYX currently has no mastering-specific ONNX weights or held-out preference set. The Mastering Assistant therefore keeps its deterministic planner as the visible order. This document describes the local evaluation contract needed before a model can be considered for a later activation review.

## Blind preference set

The Mastering Assistant can collect a pair from two individual planner proposals. It renders both against the same source project with the offline Studio HQ renderer, requires measurable LUFS-I and loudness-matched auditions, randomizes the version order separately for each listener, and hides proposal identities until both votes are recorded. Each listener uses a stable 64-hex anonymous code; KYX exports its SHA-256 hash so the same listener is counted consistently across pairs. The UI cannot prove that two codes belong to two different people, so the study operator must use two listeners.

After both listeners vote and the identities are revealed, **Download local preference dataset** explicitly downloads the complete in-memory collection. KYX keeps the raw codes and rendered PCM out of the file; no pair is added to a project, saved automatically, or uploaded. The user can import the previous JSON into a later session and add more pairs. `sourceMixHash` is a component-session-salted hash of the current project revision marker. It omits project IDs and names, but it is not a rendered-audio fingerprint and only detects repeats while that collector instance is open. Maintain a separate held-out source ledger when combining files, keep one pair per source mix, and keep the held-out split outside any training set.

The dataset is JSON with schema `kyx.mastering-ranker-blind-set`, version `3`, and a declared split of either `development` or `held-out-blind`. Development data may train or tune a future ranker. Held-out blind data is reserved for final evaluation; the evaluator accepts only a dataset declared `held-out-blind` and refuses development data. Keep the held-out file under separate custody so it is not accidentally relabeled or used for training. Each pair has:

- a unique short `pairId`;
- an opaque locally salted SHA-256 `sourceMixHash` instead of a filename, project ID, or audio; it is only a session-local revision marker, not a unique audio fingerprint;
- one `genreBucket`: `electronic`, `hip-hop`, `rock`, `acoustic`, `orchestral`, `ambient`, or `other`;
- exactly two rendered proposal candidates, each with a stable short ID, the exact 51-number `mastering.features.v1` input vector in `features`, and a `safeAfterPreview` result;
- at least two judgments from distinct reviewers, each using a SHA-256 `reviewerHash` and the preferred candidate ID, or `null` for a tie.

Candidate previews come from the same local offline renderer at the same sample rate and quality. The `candidates` array is stored in deterministic planner order, which supplies the deterministic baseline order; the evaluator rejects any baseline prediction that differs from that order. Feature vectors are required so the exact model input can be replayed for every pair; they contain normalized measurements and candidate parameter features, never PCM or project metadata. Keep raw audio, project names, reference filenames, reviewer codes, and account identifiers outside these JSON files.

## Train a local candidate

Export a Development dataset, then run the offline trainer:

```powershell
npm run mastering-ranker:train -- --dataset .\private-eval\development.json --out-dir .\scratch\mastering-ranker-candidate
```

The trainer rejects held-out data, requires at least two reviewer codes and four genre buckets, and after removing disagreements/ties requires at least 100 resolved training pairs plus 20 internal Development validation pairs. It fits a small linear scalar ranker with pairwise logistic loss and L2 regularization, using a fixed seed and a deterministic per-genre split. The exported ONNX graph is checked with `onnx.checker` and run through local CPU ONNX Runtime against the NumPy scores before any artifact is written.

The output directory contains `mastering-ranker-v1.onnx`, `mastering-ranker-v1.manifest.candidate.json` (`evaluation: null`), and an aggregate training report. The trainer refuses to write under `public/`; it does not install, activate, or claim a passing evaluation for the model. The internal Development validation only filters out candidates that fail to beat the planner on that development split. It is not held-out evidence and cannot satisfy the activation gate. Keep the candidate under review until predictions and runtime measurements from the target browser/device are compared against a separately controlled held-out set.

Run `npm run mastering-ranker:trainer-smoke` to check the trainer and ONNX export path with a synthetic signal. That command writes no model or dataset and is only a plumbing check, not mastering-quality evidence.

## Model predictions

Generate the pair orders and runtime artifact locally with the exact candidate model and held-out file:

```powershell
npm run mastering-ranker:predict:browser -- --dataset .\private-eval\blind-set.json --model .\scratch\mastering-ranker-candidate\mastering-ranker-v1.onnx --manifest .\scratch\mastering-ranker-candidate\mastering-ranker-v1.manifest.candidate.json --out .\private-eval\predictions.json --runtime-out .\private-eval\runtime-measurement.json
```

This opens headless Chromium on the same Windows machine, serves the files only from a loopback HTTP server, and runs ONNX Runtime Web with the same single-threaded WASM provider as the application. It checks the model hash against the unevaluated candidate manifest, accepts only `held-out-blind`, warms inference, and emits one model order and the deterministic planner order for each pair. The prediction artifact carries the exact model hash, feature version, and per-pair orders.

The browser harness builds and runs KYX's production `mastering-ranker-worker.ts` entry point, serving the candidate model and ONNX Runtime WebAssembly from the local process. Runtime sidecar schema v2 binds timing and memory samples to the exact model and dataset hashes and records the Chromium/host runtime, benchmark script SHA-256, exact served worker-bundle SHA-256, ONNX Runtime Web version, and WASM binary SHA-256. The p95 measures each two-candidate worker request after warmup, including message transfer, feature validation, ONNX Runtime Web/WASM inference, and score normalization. On Windows, a dedicated Chromium process tree is sampled before the benchmark and after warmup/inference groups. It samples every 10 pairs for sets up to 1,000 pairs and scales the interval for larger sets to keep at most 100 groups; `peakMemoryMiB` is the maximum private-bytes increase over the pre-benchmark baseline. This is an incremental process-tree measure, not total Chromium memory or a full-system RSS guarantee. The evaluator checks the declared interval and minimum sample count. Retain `runtime-measurement.json` with the aggregate evaluation report as the audit record.

The output JSON uses schema `kyx.mastering-ranker-predictions`, version `1`, the exact `featureVersion` and model SHA-256, measured p95 inference time and sampled peak memory, plus one pair result for every held-out pair. Each result contains `modelOrder` and `deterministicOrder`; the latter must equal the candidates' stored planner order.

## Evaluate and create a report

Run the local command with the blind set and predictions:

```powershell
npm run mastering-ranker:evaluate -- --dataset .\private-eval\blind-set.json --predictions .\private-eval\predictions.json --runtime-measurement .\private-eval\runtime-measurement.json --report-out .\private-eval\mastering-ranker-evaluation-v2.json --report-asset-path /models/mastering-ranker-evaluation-v2.json
```

The evaluator checks pair and candidate identity, exact feature vector width/range, reviewer hashes, duplicate source-mix hashes, held-out split, genre buckets, and ranking permutations. It also requires the runtime artifact from the browser prediction step; model hash, dataset hash, pair/inference counts, p95, and memory values must all match exactly. The report schema v2 records the runtime artifact's SHA-256, binding the report and later manifest gate to that evidence. It aggregates votes by pair, compares model and deterministic preference rates, computes a deterministic paired bootstrap lower 95% confidence bound, and counts cases where the model ranks a technically unsafe preview above a safe baseline. Prediction orders must be generated by the exact model identified by `modelHash`, using the included feature vectors. The report contains aggregate results and hashes, not audio or reviewer identities.

The manifest gate passes only with at least 100 held-out pairs, two or more distinct reviewer codes, four or more genre buckets, model preference above baseline with a positive lower confidence bound, zero safety regressions, p95 inference at or below 250 ms, and peak memory at or below 128 MiB. `reviewerCodeCount` counts distinct hashes; neither the collector nor evaluator can prove that they belong to different people. The study operator must verify this before any product activation review. The command returns a nonzero exit status when the report does not meet its machine-checkable criteria. A passing report is not an automatic activation: its exact bytes must be installed at the manifest's local `reportPath`, the printed `reportHash` and evaluation summary must match the model manifest, and the separate product activation review is still required.

The browser verifies the report SHA-256 and summary before displaying that the evaluation gate passed. The current application has no active mastering-ranker mode, so every model comparison remains shadow-only and cannot reorder or apply the suggestions.
