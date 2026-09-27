/**
 * A plain DLL with NO clap_entry export — the negative test fixture for the
 * probe (ADR 0016). Loading must succeed and the probe must classify the
 * file as "not a CLAP" (exit 2), not as a crash.
 */
__declspec(dllexport) int fixture_empty_marker(void) {
  return 1;
}
