/** Sanitize an optional user-entered mastering revision for safe delivery filenames. */
export function masteringVersionSuffix(value: string): string {
  const revision = value
    .trim()
    .replace(/[^\w\- ]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 32);
  return revision ? `-${revision}` : "";
}
