/**
 * Minimal 5-field cron parser — pure TypeScript, zero dependencies.
 * Supports: * | N | *\/N | N-M | N,M,…
 *
 * Field order: minute(0-59) hour(0-23) dom(1-31) month(1-12) dow(0-6, 0=Sunday)
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type CronFieldType = "wildcard" | "value" | "step" | "range" | "list";

export interface CronField {
  type: CronFieldType;
  values?: number[];
  step?: number;
  min?: number;
  max?: number;
}

export interface ParsedCron {
  minute: CronField;     // 0-59
  hour: CronField;       // 0-23
  dayOfMonth: CronField; // 1-31
  month: CronField;      // 1-12
  dayOfWeek: CronField;  // 0-6
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Parse a 5-field cron expression. Throws on invalid input. */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression (expected 5 fields, got ${parts.length}): "${expr}"`);
  }

  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  return {
    minute: parseField(minuteStr, 0, 59),
    hour: parseField(hourStr, 0, 23),
    dayOfMonth: parseField(domStr, 1, 31),
    month: parseField(monthStr, 1, 12),
    dayOfWeek: parseField(dowStr, 0, 6),
  };
}

/**
 * Returns the most recent past fire time strictly before `now`.
 * Returns null if the expression never fired in the past year.
 *
 * Algorithm: backward minute-walk, max ~525,600 iterations (< 5ms).
 */
export function prevFireTime(cron: ParsedCron, now: Date): Date | null {
  const limit = new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);
  // Start one minute before now, normalized to minute boundary
  let candidate = new Date(now.getTime() - 60_000);
  candidate.setSeconds(0, 0);

  while (candidate > limit) {
    if (matchesCron(cron, candidate)) return candidate;
    candidate = new Date(candidate.getTime() - 60_000);
  }
  return null;
}

/**
 * Returns the next fire time strictly after `now`.
 */
export function nextFireTime(cron: ParsedCron, now: Date): Date {
  // Start one minute after now, normalized
  let candidate = new Date(now.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  const limit = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (candidate <= limit) {
    if (matchesCron(cron, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  // Fallback: expression never fires in a year — return far future
  return new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);
}

/**
 * Returns true if the schedule is overdue: the previous fire time is after
 * `lastRun` (or `lastRun` is null — meaning it has never run).
 */
export function isOverdue(
  cron: ParsedCron,
  lastRun: Date | null,
  now: Date,
  graceMs = 0
): boolean {
  const prev = prevFireTime(cron, new Date(now.getTime() + graceMs));
  if (!prev) return false;
  if (!lastRun) return true;
  return prev > lastRun;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function parseField(raw: string, rangeMin: number, rangeMax: number): CronField {
  // Wildcard *
  if (raw === "*") return { type: "wildcard" };

  // Step */N
  if (raw.startsWith("*/")) {
    const step = parseInt(raw.slice(2), 10);
    if (isNaN(step) || step < 1) throw new Error(`Invalid step in cron field: "${raw}"`);
    return { type: "step", step };
  }

  // Range N-M
  if (raw.includes("-") && !raw.includes(",")) {
    const [a, b] = raw.split("-").map(Number);
    if (isNaN(a) || isNaN(b) || a < rangeMin || b > rangeMax || a > b) {
      throw new Error(`Invalid range in cron field: "${raw}"`);
    }
    return { type: "range", min: a, max: b };
  }

  // List N,M,...
  if (raw.includes(",")) {
    const values = raw.split(",").map(Number);
    if (values.some((v) => isNaN(v) || v < rangeMin || v > rangeMax)) {
      throw new Error(`Invalid list value in cron field: "${raw}"`);
    }
    return { type: "list", values };
  }

  // Single integer
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < rangeMin || n > rangeMax) {
    throw new Error(`Invalid cron field value (${rangeMin}-${rangeMax}): "${raw}"`);
  }
  return { type: "value", values: [n] };
}

export function matchesCron(cron: ParsedCron, d: Date): boolean {
  return (
    fieldMatches(cron.minute, d.getMinutes()) &&
    fieldMatches(cron.hour, d.getHours()) &&
    fieldMatches(cron.dayOfMonth, d.getDate()) &&
    fieldMatches(cron.month, d.getMonth() + 1) && // getMonth() is 0-indexed
    fieldMatches(cron.dayOfWeek, d.getDay())       // POSIX OR semantics
  );
}

function fieldMatches(field: CronField, value: number): boolean {
  switch (field.type) {
    case "wildcard": return true;
    case "value":    return field.values!.includes(value);
    case "step":     return value % field.step! === 0;
    case "range":    return value >= field.min! && value <= field.max!;
    case "list":     return field.values!.includes(value);
  }
}
