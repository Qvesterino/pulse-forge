# KYX Windows MRT2 companion

This directory contains the source for the optional Windows x64 companion
binary expected by the Electron shell at:

```
resources/mrt2-windows/kyx-mrt2-windows-host.exe
```

The companion speaks the framed protocol documented in
[`docs/MRT2-NATIVE-HOST-PROTOCOL.md`](../../docs/MRT2-NATIVE-HOST-PROTOCOL.md).
It uses Magenta RealTime's public JAX API for bounded capture generation. Text,
25 Hz piano-roll note conditioning and drum mode are forwarded into the JAX
token inputs frame by frame. The first Windows adapter advertises `capture`
only; realtime playback is enabled only after the benchmark gate in
`docs/adr/0013-windows-generative-companion.md` has been met on representative
hardware.

## Development run

Use a Python 3.11–3.12 environment with a Windows-compatible JAX build and
`magenta-rt` installed. The model root must contain the shared resources and
the raw `mrt2_small.safetensors` checkpoint:

```powershell
python -m pip install "magenta-rt[jax]" pyinstaller
python .\companion\mrt2-windows\kyx_mrt2_windows_host.py `
  --model-root "$env:USERPROFILE\Documents\Magenta\magenta-rt-v2-windows"
```

After the smoke run, `npm run build:mrt2-windows-host` creates the fixed
`build/mrt2-windows/kyx-mrt2-windows-host.exe` artifact. Copy the executable
and its verified manifest to the desktop packaging resources only for an
explicitly tested Windows build.

The opt-in Electron package validates the helper and model hashes again and
ships the helper plus manifest under `resources/mrt2-windows/`:

```powershell
$env:KYX_MRT2_WINDOWS_HOST = "$pwd\build\mrt2-windows\kyx-mrt2-windows-host.exe"
$env:KYX_MRT2_WINDOWS_MODEL_ROOT = "$env:USERPROFILE\Documents\Magenta\magenta-rt-v2-windows"
$env:KYX_MRT2_WINDOWS_MANIFEST = "$pwd\build\mrt2-windows\kyx-mrt2-windows-manifest.json"
npm run desktop:build:windows:mrt2
```

The model weights are intentionally not copied into the installer; the
companion reads the fixed user model root and refuses to download assets.

With the upstream `mrt` CLI, the asset root can be prepared explicitly (the
Windows companion does not download anything at runtime):

```powershell
$modelRoot = "$env:USERPROFILE\Documents\Magenta\magenta-rt-v2-windows"
mrt models init --download-path $modelRoot
mrt checkpoints download mrt2_small --download-path $modelRoot
```

The first line on stdout is the bounded `ready` handshake. All subsequent
stdout bytes are binary protocol frames; diagnostics belong on stderr.

For an explicit package release, create and verify the manifest before copying
the helper into the desktop resources:

```powershell
$env:KYX_MRT2_WINDOWS_HOST = "$pwd\build\mrt2-windows\kyx-mrt2-windows-host.exe"
$env:KYX_MRT2_WINDOWS_MODEL_ROOT = "$env:USERPROFILE\Documents\Magenta\magenta-rt-v2-windows"
$env:KYX_MRT2_WINDOWS_MANIFEST = "$pwd\build\mrt2-windows\kyx-mrt2-windows-manifest.json"
npm run create:mrt2:windows:manifest
npm run verify:mrt2:windows:package
```

The model data can be removed later with the guarded
`scripts/uninstall-mrt2-windows-assets.ps1` script (`-WhatIf` is supported).

The upstream project currently documents JAX for offline/batch use and MLX
realtime on Apple Silicon. Installing this companion does not imply native
Windows realtime support; the capability handshake remains the source of
truth.
