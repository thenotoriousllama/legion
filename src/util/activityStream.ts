/**
 * Process-wide activity stream that the Dashboard webview subscribes to for
 * its live "what is Legion doing right now" terminal-style log + progress bar.
 *
 * Pre-v1.2.18 the document pass only spoke to VS Code's progress toast and
 * vanished into a void afterwards. The stream gives us:
 *   • a ring-buffered history (last N events) so the Activity tab is
 *     populated immediately when the user opens it mid-pass or after one
 *     just finished
 *   • a fanout EventEmitter for live tailing
 *   • a registered "active operation" + cancellation source so the Dashboard
 *     Cancel button can stop the same job the toast X stops
 *
 * Singleton-but-resettable for tests via `__resetForTest`.
 */
import * as vscode from "vscode";

export interface ActivityEvent {
  /** Epoch ms; set by `emit` so callers don't have to. */
  ts: number;
  level: "info" | "warn" | "error" | "progress" | "done" | "cancelled";
  /** Coarse source tag — "document-pass", "update-pass", "lint", etc. */
  source: string;
  /** Single-line message. UI will render multi-line wrapping itself. */
  message: string;
  /** Optional progress fraction. UI uses this to drive the bar. */
  progress?: { current: number; total: number };
  /** Optional structured error blob for "error" events. */
  error?: string;
}

export interface ActiveOperation {
  /** Unique-ish id — use the source + start-ts. */
  id: string;
  /** Human label shown next to the progress bar. */
  label: string;
  /** Started timestamp (epoch ms). */
  startedAt: number;
  /** Token source — `cancel()` is called by the Dashboard Cancel button. */
  tokenSource: vscode.CancellationTokenSource;
}

const RING_CAP = 500;

export class ActivityStream {
  private static _instance?: ActivityStream;

  static get instance(): ActivityStream {
    if (!this._instance) this._instance = new ActivityStream();
    return this._instance;
  }

  /** Test-only reset. Production code should never call this. */
  static __resetForTest(): void {
    this._instance = undefined;
  }

  private readonly _emitter = new vscode.EventEmitter<ActivityEvent>();
  private readonly _opEmitter = new vscode.EventEmitter<ActiveOperation | null>();
  private _ring: ActivityEvent[] = [];
  private _active: ActiveOperation | null = null;

  /** Fired on every new event (after the ring buffer is updated). */
  readonly onEvent = this._emitter.event;

  /** Fired when an operation starts/clears so the Dashboard can show a bar. */
  readonly onActiveChanged = this._opEmitter.event;

  /**
   * Append an event to the ring buffer and notify subscribers.
   * Caller doesn't need to set `ts` — we stamp it here.
   */
  emit(event: Omit<ActivityEvent, "ts">): void {
    const full: ActivityEvent = { ...event, ts: Date.now() };
    this._ring.push(full);
    if (this._ring.length > RING_CAP) {
      this._ring.shift();
    }
    this._emitter.fire(full);
  }

  /** Snapshot of the current ring buffer (oldest → newest). */
  history(): ActivityEvent[] {
    return [...this._ring];
  }

  /**
   * Clear the ring buffer. Used by the Dashboard's "Clear log" button.
   * Does not affect any active operation.
   */
  clearHistory(): void {
    this._ring = [];
  }

  /**
   * Register an operation as active. Replaces any existing active op without
   * cancelling it — caller is responsible for sequencing if that matters.
   */
  setActive(op: ActiveOperation): void {
    this._active = op;
    this._opEmitter.fire(op);
  }

  /** Mark the active operation as finished. Idempotent. */
  clearActive(): void {
    if (this._active) {
      this._active = null;
      this._opEmitter.fire(null);
    }
  }

  /** Currently-running operation, if any. */
  get active(): ActiveOperation | null {
    return this._active;
  }

  /**
   * Trigger cancellation on the active operation's token. No-op when nothing
   * is running. Returns true if a cancel was actually requested.
   */
  cancelActive(): boolean {
    if (!this._active) return false;
    this._active.tokenSource.cancel();
    return true;
  }
}
