# ADR 0001 — Browser-first platform

Date: 2026-08-15
Status: Accepted

Pulse Forge is built as a browser-native application (TypeScript, React, Web Audio API). The browser is the primary product, not a prototype. No Electron/Tauri/C++/native audio dependencies are introduced. Desktop packaging may come later but must not contaminate the core design.

Consequence: the entire toolchain is `npm`-based (Vite, Vitest); audio runs on Web Audio + AudioWorklet; persistence is IndexedDB/OPFS.
