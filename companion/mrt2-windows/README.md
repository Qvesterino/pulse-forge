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

## Experimental WSL2 / NVIDIA stream

Windows JAX is the default capture backend. An optional WSL2 manager can run
the same protocol host against the Linux NVIDIA JAX wheel. This path requires
WSL2, an NVIDIA driver visible inside WSL, Python 3.12, the CUDA-enabled JAX
wheel and the model files at the fixed Windows model root. The model root must
be on a drive mounted in WSL (the default `C:\Users\…` path maps under
`/mnt/c/Users/…`).

Inside the selected WSL distribution, install the runtime in a dedicated venv
and verify that JAX sees the GPU:

```bash
uv venv --python 3.12 ~/.venvs/kyx-mrt2-wsl
source ~/.venvs/kyx-mrt2-wsl/bin/activate
uv pip install "magenta-rt==2.0.3" "jax[cuda13]"
python -c 'import jax; print(jax.devices())'
```

Create and verify the Windows package manifest after the host executable and
model assets have been prepared; it also pins the WSL Python host script. The
optional desktop build ships that script as a resource, not in the browser
bundle. To select WSL2, set these main-process environment values before
launching the packaged MRT2-enabled KYX build:

```powershell
$env:KYX_MRT2_WINDOWS_BACKEND = "wsl2"
$env:KYX_MRT2_WSL_DISTRO = "Ubuntu"
$env:KYX_MRT2_WSL_PYTHON = "/home/<linux-user>/.venvs/kyx-mrt2-wsl/bin/python"
```

This only enables the experimental `near-realtime` tier. WSL2/CUDA remains
optional, is not installed or configured by KYX, and is not promoted to
`realtime` unless a representative 10-minute benchmark passes every gate.
Missing WSL, Python, GPU or model assets must leave ordinary editing and
captured-audio workflows unaffected.

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

Run the protocol benchmark against the packaged helper. For a WSL2/CUDA
development run, set the host to `wsl.exe` and provide only fixed paths in the
argument array; this exercises the same framed protocol without Electron:

```powershell
$env:KYX_MRT2_WINDOWS_HOST = "wsl.exe"
$env:KYX_MRT2_WINDOWS_MODEL_ROOT = "/mnt/c/Users/<windows-user>/Documents/Magenta/magenta-rt-v2-windows"
$env:KYX_MRT2_BENCHMARK_HOST_ARGS = '["--distribution","Ubuntu","--exec","/usr/bin/env","XLA_PYTHON_CLIENT_PREALLOCATE=false","XLA_FLAGS=--xla_gpu_autotune_level=1","TF_GPU_ALLOCATOR=cuda_malloc_async","/home/<linux-user>/.venvs/kyx-mrt2-wsl/bin/python","/mnt/c/Program Files/KYX/resources/mrt2-windows/kyx_mrt2_windows_host.py","--execution-mode","near-realtime"]'
$env:KYX_MRT2_BENCHMARK_CWD = "$pwd"
$env:KYX_MRT2_BENCHMARK_MODE = "live"
$env:KYX_MRT2_BENCHMARK_SECONDS = "600"
npm run benchmark:mrt2:windows
```

Example for the Python host:

```powershell
$env:KYX_MRT2_WINDOWS_HOST = "D:\path\to\python.exe"
$env:KYX_MRT2_BENCHMARK_HOST_ARGS = '["D:\\pulse-forge\\companion\\mrt2-windows\\kyx_mrt2_windows_host.py"]'
$env:KYX_MRT2_BENCHMARK_CWD = "D:\pulse-forge\companion\mrt2-windows"
npm run benchmark:mrt2:windows
```

The capture response reports measured per-frame inference p95/mean and the
audio-to-wall-time ratio. Packet arrival intervals are retained as a separate
transport diagnostic and are not substituted for model frame latency.

Use `KYX_MRT2_BENCHMARK_REPORT` to save the JSON gate report. A realtime
promotion run must use 600 seconds and pass the finite-PCM, coverage,
sequence, no-underrun, frame-p95 and realtime-factor gates on representative
hardware.

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

The upstream project documents JAX generation on Linux and MLX realtime on
Apple Silicon; JAX's NVIDIA support under WSL2 is experimental. Installing
this companion does not imply Windows realtime support; the capability
handshake and benchmark gate remain authoritative.
