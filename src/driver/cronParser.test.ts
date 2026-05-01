/**
 * Tests for src/driver/cronParser.ts
 *
 * NOTE: Stubs. Full coverage tracked in library/qa/2026-04-30-qa-report.md.
 */

import { parseCron, isOverdue, prevFireTime } from "./cronParser";

describe("parseCron", () => {
  it("parses a valid 5-field expression", () => {
    const result = parseCron("0 9 * * 1");
    expect(result.minute.type).toBe("value");
    expect(result.hour.type).toBe("value");
    expect(result.dayOfWeek.type).toBe("value");
  });

  it("throws on invalid expression", () => {
    expect(() => parseCron("not-a-cron")).toThrow();
  });

  it("supports wildcard", () => {
    const result = parseCron("* * * * *");
    expect(result.minute.type).toBe("wildcard");
  });

  it("supports step syntax */15", () => {
    const result = parseCron("*/15 * * * *");
    expect(result.minute.type).toBe("step");
    expect(result.minute.step).toBe(15);
  });
});

describe("isOverdue", () => {
  it("returns true when lastRun is null", () => {
    const cron = parseCron("0 0 * * *");
    const now = new Date();
    expect(isOverdue(cron, null, now)).toBe(true);
  });

  it("returns false when lastRun is after the previous fire time", () => {
    const cron = parseCron("0 0 * * *");
    const now = new Date();
    const lastRun = new Date(now.getTime() + 1000); // future — never overdue
    expect(isOverdue(cron, lastRun, now)).toBe(false);
  });
});

describe("prevFireTime", () => {
  it("returns a date in the past", () => {
    const cron = parseCron("* * * * *");
    const now = new Date();
    const prev = prevFireTime(cron, now);
    expect(prev).not.toBeNull();
    expect(prev!.getTime()).toBeLessThan(now.getTime());
  });
});
