/**
 * JOB CENTER (Wave 1/B) — one registry for every long operation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Long work in the app used to be tracked by whichever component started it
 * (`busy`, `songBusy`, `theatreBusy`, `exportBusy`, `workGate`, ...). That
 * works until two long operations overlap: one flag clears, another was never
 * read, a panel unmounts mid-flight and the operation disappears from the UI
 * while still running. The Job Center inverts that: the JOB is the durable
 * thing, components only render it.
 *
 * CONTRACT
 * --------
 *  - `startJob` returns a handle; the owner reports `update` / `done` /
 *    `fail` and observes `handle.signal` for cancellation.
 *  - A job always settles EXACTLY once. A late `done()` after `cancelJob()`
 *    is ignored (no double reporting), and `timeoutMs` guarantees that a job
 *    whose owner died (unmounted panel, lost worker) cannot sit "running"
 *    forever — the same stuck-flag failure class the recovery audit hunted.
 *  - `key` dedupes: two identical jobs (same key) never run at once; the
 *    second `startJob` returns null so the caller can attach to the first.
 *  - History is bounded (running jobs + last N settled). Jobs are ephemeral
 *    by design — nothing is persisted; a reload is a clean slate.
 */

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobView {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  /** 0..1; -1 = indeterminate. */
  progress: number;
  note?: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  cancellable: boolean;
}

export interface JobHandle {
  readonly id: string;
  /** Report progress (clamped). `progress < 0` = indeterminate. */
  update(progress: number, note?: string): void;
  done(note?: string): void;
  fail(error: unknown): void;
  /** Aborted by `cancelJob`; owners should stop and settle via `fail`. */
  readonly signal: AbortSignal;
}

export interface JobNotice {
  id: number;
  jobId: string;
  kind: string;
  label: string;
  status: JobStatus;
  text: string;
  ts: number;
}

export interface StartJobInput {
  kind: string;
  label: string;
  /** Dedupe key for running jobs. Omit to always start a new job. */
  key?: string;
  cancellable?: boolean;
  /** Auto-fail the job after this long (guards a lost owner / stuck job). */
  timeoutMs?: number;
  /** Initial note shown under the label. */
  note?: string;
}

export interface JobSnapshot {
  jobs: JobView[];
  notices: JobNotice[];
  revision: number;
  runningCount: number;
}

const HISTORY_CAP = 20;
const NOTICE_CAP = 4;

interface JobRecord extends JobView {
  key?: string;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController;
  settled: boolean;
}

let records: JobRecord[] = [];
let notices: JobNotice[] = [];
let nextJobId = 1;
let nextNoticeId = 1;
let revision = 0;
let snapshot: JobSnapshot = { jobs: [], notices: [], revision: 0, runningCount: 0 };
const listeners = new Set<() => void>();

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function rebuildSnapshot(): void {
  revision += 1;
  const running = records.filter((record) => record.status === "running");
  const settled = records.filter((record) => record.status !== "running");
  const jobs = [...running, ...settled.slice(-HISTORY_CAP)];
  snapshot = {
    jobs: jobs.map(({ timer: _timer, controller: _controller, settled: _settled, key: _key, ...view }) => view),
    notices: [...notices],
    revision,
    runningCount: running.length,
  };
}

function notify(): void {
  rebuildSnapshot();
  for (const listener of [...listeners]) listener();
}

function trimHistory(): void {
  const settled = records.filter((record) => record.status !== "running");
  if (settled.length <= HISTORY_CAP) return;
  const drop = new Set(settled.slice(0, settled.length - HISTORY_CAP).map((record) => record.id));
  records = records.filter((record) => !drop.has(record.id));
}

function pushNotice(record: JobRecord, status: JobStatus, text: string): void {
  nextNoticeId += 1;
  notices = [
    ...notices,
    { id: nextNoticeId, jobId: record.id, kind: record.kind, label: record.label, status, text, ts: Date.now() },
  ].slice(-NOTICE_CAP);
}

function settle(record: JobRecord, status: Exclude<JobStatus, "running">, note?: string, error?: string): void {
  if (record.settled) return;
  record.settled = true;
  if (record.timer != null) {
    clearTimeout(record.timer);
    record.timer = null;
  }
  record.status = status;
  record.finishedAt = Date.now();
  if (note !== undefined) record.note = note;
  if (error !== undefined) record.error = error;
  if (status === "done") record.progress = 1;
  pushNotice(
    record,
    status,
    status === "done"
      ? `✓ ${record.label}`
      : status === "cancelled"
        ? `✗ ${record.label} — cancelled`
        : `✗ ${record.label} — ${error ?? "failed"}`,
  );
  trimHistory();
  notify();
}

/**
 * Start a job. Returns null when `key` matches a RUNNING job (the caller
 * should treat the work as already underway instead of duplicating it).
 */
export function startJob(input: StartJobInput): JobHandle | null {
  if (input.key != null && records.some((record) => record.status === "running" && record.key === input.key)) {
    return null;
  }
  nextJobId += 1;
  const controller = new AbortController();
  const record: JobRecord = {
    id: `job-${nextJobId}`,
    kind: input.kind,
    label: input.label,
    status: "running",
    progress: -1,
    startedAt: Date.now(),
    cancellable: input.cancellable !== false,
    key: input.key,
    timer: null,
    controller,
    settled: false,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  records = [...records, record];
  const timeoutMs = input.timeoutMs;
  if (timeoutMs != null && timeoutMs > 0) {
    record.timer = setTimeout(
      () => settle(record, "failed", undefined, `timed out after ${Math.round(timeoutMs / 1000)}s`),
      timeoutMs,
    );
  }
  notify();
  return {
    id: record.id,
    signal: controller.signal,
    update: (progress, note) => {
      if (record.settled) return;
      record.progress = progress < 0 ? -1 : Math.min(1, Math.max(0, progress));
      if (note !== undefined) record.note = note;
      notify();
    },
    done: (note) => settle(record, "done", note),
    fail: (error) => settle(record, "failed", undefined, errorText(error)),
  };
}

/** Cancel a running job: aborts its signal and settles it as cancelled. */
export function cancelJob(id: string): boolean {
  const record = records.find((candidate) => candidate.id === id);
  if (record == null || record.status !== "running") return false;
  record.controller.abort();
  settle(record, "cancelled");
  return true;
}

/** Cancel every running job (project close / teardown). Returns the count. */
export function cancelAllJobs(): number {
  const running = records.filter((record) => record.status === "running");
  for (const record of running) cancelJob(record.id);
  return running.length;
}

export function jobSnapshot(): JobSnapshot {
  return snapshot;
}

export function subscribeJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dismissJobNotice(id: number): void {
  if (!notices.some((notice) => notice.id === id)) return;
  notices = notices.filter((notice) => notice.id !== id);
  notify();
}

export function runningJobCount(): number {
  return snapshot.runningCount;
}

/** Test/diagnostic hook — the registry is per-window by design. */
export function resetJobCenterForTests(): void {
  for (const record of records) {
    if (record.timer != null) clearTimeout(record.timer);
  }
  records = [];
  notices = [];
  nextJobId = 1;
  nextNoticeId = 1;
  revision = 0;
  snapshot = { jobs: [], notices: [], revision: 0, runningCount: 0 };
  listeners.clear();
}
