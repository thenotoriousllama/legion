# Feature #004: Scheduled Research — Automatic Agenda Drain on a Cron Schedule

> **Legion VS Code Extension** — Feature PRD #004 of 6
>
> **Status:** Ready for implementation
> **Priority:** P2
> **Effort:** S (1-3h)
> **Schema changes:** None (`.legion/config.json` gets a new field)

---

## Phase Overview

### Goals

Legion maintains a `wiki/research-agenda.md` — a checklist of topics that the team or AI agents have flagged for deeper investigation. The `legion.drainAgenda` command processes all pending items: it runs a research loop for each unchecked item, files the resulting wiki pages, and checks the item off. Currently the user must remember to run this command manually; it is easy to forget and the agenda backlog grows stale.

This PRD introduces automatic scheduled execution of `legion.drainAgenda` using a cron-style schedule configured via `legion.researchSchedule`. Rather than spawning a background timer that runs even when VS Code is closed, the schedule is checked on VS Code activation and compared against a `last_agenda_drain` timestamp stored in `.legion/config.json`. If the configured interval has elapsed, Legion surfaces a non-intrusive notification prompting the user to run the drain (or snooze it). This keeps the feature deterministic, auditable, and respectful of the user's flow — no silent background API calls.

The cron parser is implemented in pure TypeScript with no npm dependencies, covering the standard five-field format (`minute hour dom month dow`). The implementation is minimal but correct for the common patterns a developer would use: `"0 9 * * 1"` (Monday 9am), `"0 8 * * *"` (daily at 8am), `"0 */4 * * *"` (every 4 hours).

### Scope

- New setting: `legion.researchSchedule` (string, cron format, default `""` = disabled)
- New setting: `legion.researchScheduleEnabled` (boolean, default `false`) — safety gate; schedule only fires when explicitly enabled
- Schedule check on `activate()`: compare `last_agenda_drain` in `.legion/config.json` against the configured cron's previous fire time; show notification if overdue
- Notification with three actions: "Run Now", "Snooze 1 day", "Disable Schedule"
- `.legion/config.json` updated with `last_agenda_drain` (ISO-8601) after each successful drain
- Integration with `legion.autoGitCommit`: if true, auto-commit wiki changes after scheduled drain
- Minimal cron parser in `src/driver/cronParser.ts` — `parsesCron(expr)` + `prevFireTime(expr, now)` + `nextFireTime(expr, now)` + `isOverdue(expr, lastRun, now, graceMs)`

### Out of scope

- Background timer / `setInterval` — not implemented; the schedule is only checked at VS Code startup
- System-level cron integration (`crontab`, Windows Task Scheduler) — out of scope; the VS Code check-on-activate pattern is sufficient for developer tooling
- Per-agenda-item scheduling (different schedule per research topic) — all items share one global schedule
- More than 5-field cron syntax (no seconds, no `@monthly` aliases) — minimal parser only

### Dependencies

- **Blocks:** none
- **Blocked by:** none; `drainAgenda.ts` already exists and this PRD wraps it
- **External:** none (no new npm packages)

---

## User Stories

### US-4.1 — Configure a research schedule

**As a** developer, **I want to** set a cron schedule for research agenda draining in VS Code settings, **so that** Legion automatically prompts me to run the drain at a time that fits my workflow.

**Acceptance criteria:**
- AC-4.1.1 Given I set `legion.researchSchedule = "0 9 * * 1"` and `legion.researchScheduleEnabled = true` in VS Code settings, then Legion checks this schedule on every VS Code startup.
- AC-4.1.2 Given the schedule is set but `legion.researchScheduleEnabled` is `false`, then no notification is ever shown and no drain is triggered automatically.
- AC-4.1.3 Given an invalid cron expression (e.g., `"not-a-cron"`), when VS Code activates, then Legion logs a warning to the output channel and ignores the schedule rather than throwing.
- AC-4.1.4 The `legion.researchSchedule` setting appears in the VS Code settings UI under "Legion > Research" with a description and example values.

### US-4.2 — Prompted drain on startup

**As a** developer who configured a Monday 9am schedule, **I want** Legion to notify me on Monday morning when I open VS Code, **so that** I can approve the drain with a single click rather than remembering to run it manually.

**Acceptance criteria:**
- AC-4.2.1 Given the schedule is enabled and the cron's previous fire time is after `last_agenda_drain`, when VS Code activates, then Legion shows an information notification: "Research agenda drain is due (last run: {relative date}). Run now?"
- AC-4.2.2 Clicking "Run Now" triggers `legion.drainAgenda` and updates `last_agenda_drain` to now.
- AC-4.2.3 Clicking "Snooze 1 day" writes `last_agenda_drain` to `now + 24h` without running the drain (effectively postponing the next notification by one day).
- AC-4.2.4 Clicking "Disable Schedule" sets `legion.researchScheduleEnabled = false` in workspace settings and shows a confirmation.
- AC-4.2.5 If the research agenda file is empty (no unchecked items), no notification is shown even if the schedule is overdue.

### US-4.3 — Post-drain state update

**As a** developer running a scheduled drain, **I want** the drain timestamp to be updated and the wiki changes auto-committed (if configured), **so that** the research results are captured in git history and the schedule won't fire again until the next interval.

**Acceptance criteria:**
- AC-4.3.1 After a successful `legion.drainAgenda` run (scheduled or manual), `last_agenda_drain` in `.legion/config.json` is updated to the current ISO-8601 timestamp.
- AC-4.3.2 If `legion.autoGitCommit` is `true`, Legion runs `git add library/knowledge-base/wiki/ && git commit -m "legion: scheduled agenda drain"` after the drain completes.
- AC-4.3.3 If the drain fails mid-way, `last_agenda_drain` is NOT updated (so the notification will re-appear on the next startup).

### US-4.4 — Cron expression validation

**As a** developer configuring the schedule, **I want** to see immediate feedback when I enter an invalid cron expression, **so that** I catch typos before they silently disable the schedule.

**Acceptance criteria:**
- AC-4.4.1 The `legion.researchSchedule` setting has a `markdownDescription` in `package.json` with valid examples.
- AC-4.4.2 When `parseCron` fails to parse the expression, Legion logs `[Legion] Invalid cron expression: "<expr>" — schedule disabled` to the Legion output channel.
- AC-4.4.3 `parseCron` supports: `*`, `*/N` (every N units), single integers, comma-separated lists (e.g., `1,3,5`), and ranges (e.g., `1-5`). These cover 95%+ of real-world usage.

---

## Data Model Changes

`.legion/config.json` gains one new field:

```jsonc
{
  // existing fields...
  "last_agenda_drain": "2026-04-28T09:00:00.000Z"  // ISO-8601; null or absent means "never"
}
```

This file already exists (Legion writes it during initialization). The change is purely additive; no migration needed.

---

## API / Endpoint Specs

No HTTP API.

### Internal API — `cronParser.ts`

```typescript
export interface CronField {
  type: 'wildcard' | 'value' | 'step' | 'range' | 'list';
  values?: number[];
  step?: number;
  min?: number;
  max?: number;
}

export interface ParsedCron {
  minute:     CronField;   // 0-59
  hour:       CronField;   // 0-23
  dayOfMonth: CronField;   // 1-31
  month:      CronField;   // 1-12
  dayOfWeek:  CronField;   // 0-6 (0=Sunday)
}

/** Parse a 5-field cron expression. Throws on invalid input. */
export function parseCron(expr: string): ParsedCron;

/** Returns the most recent past fire time before `now`. Returns null if the
 *  expression never fires before `now` (e.g., a future-only expression). */
export function prevFireTime(cron: ParsedCron, now: Date): Date | null;

/** Returns the next fire time after `now`. */
export function nextFireTime(cron: ParsedCron, now: Date): Date;

/** Returns true if the schedule is overdue: the previous fire time is after lastRun. */
export function isOverdue(
  cron: ParsedCron,
  lastRun: Date | null,
  now: Date,
  graceMs?: number   // default 0; allow grace period before considering overdue
): boolean;
```

**Key implementation — `prevFireTime`:**

The algorithm walks backward in time (minute-by-minute or binary search) from `now` to find the most recent past fire time. For practical cron expressions (e.g., hourly, daily, weekly), the backward walk terminates in at most `60 × 24 × 7 = 10,080` iterations — fast enough for startup (< 1ms). A smarter backward-search algorithm can be added later if needed.

```typescript
export function prevFireTime(cron: ParsedCron, now: Date): Date | null {
  // Walk backward by 1 minute from now-1min, up to 1 year back
  const limit = new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);
  let candidate = new Date(now.getTime() - 60_000); // start 1 minute before now
  candidate.setSeconds(0, 0); // normalize to minute boundary

  while (candidate > limit) {
    if (matchesCron(cron, candidate)) return candidate;
    candidate = new Date(candidate.getTime() - 60_000);
  }
  return null; // expression never fired in the past year
}

function matchesCron(cron: ParsedCron, d: Date): boolean {
  return (
    fieldMatches(cron.minute,     d.getMinutes())    &&
    fieldMatches(cron.hour,       d.getHours())      &&
    fieldMatches(cron.dayOfMonth, d.getDate())       &&
    fieldMatches(cron.month,      d.getMonth() + 1)  && // getMonth() is 0-indexed
    fieldMatches(cron.dayOfWeek,  d.getDay())
  );
}

function fieldMatches(field: CronField, value: number): boolean {
  switch (field.type) {
    case 'wildcard': return true;
    case 'value':    return field.values!.includes(value);
    case 'step':     return value % field.step! === 0;
    case 'range':    return value >= field.min! && value <= field.max!;
    case 'list':     return field.values!.includes(value);
  }
}
```

---

## UI/UX Description

### Notification — "Drain due" prompt

Appears as a VS Code information notification (bottom-right toast) with:

```
Legion: Research agenda drain is due (last run: 3 days ago). Run now?
[Run Now]   [Snooze 1 day]   [Disable Schedule]
```

- Notification persists until dismissed or an action is clicked (it is not auto-dismissed).
- "Run Now" shows a progress bar in the status bar during the drain.
- "Snooze 1 day" shows a brief confirmation: "Snoozed — next check in ~24 hours."
- "Disable Schedule" shows a confirmation and writes `legion.researchScheduleEnabled: false` to workspace settings.

### Settings UI

Two new settings in the "Legion > Research" group:

| Setting | Type | Default | Description |
|---|---|---|---|
| `legion.researchSchedule` | string | `""` | Cron expression for automatic agenda draining. Examples: `"0 9 * * 1"` (Monday 9am), `"0 8 * * *"` (daily 8am). Empty string disables. |
| `legion.researchScheduleEnabled` | boolean | `false` | Safety gate — must be explicitly enabled for the schedule to fire. |

---

## Technical Considerations

### Check-on-activate pattern vs. background timer

VS Code extensions can use `setInterval` for background timers, but this approach has drawbacks: it fires even if the user is mid-focus, accumulates hidden API calls, and does not persist across VS Code restarts. The check-on-activate pattern is simpler, more predictable, and aligns with how users think about "daily" or "weekly" tasks: the notification appears when they open their editor, not at an arbitrary background moment.

The tradeoff: if the user never closes and reopens VS Code (e.g., a long-running development session), the drain will not be triggered automatically mid-session. This is acceptable for the initial implementation. A follow-up PRD can add an optional in-session timer check.

### `.legion/config.json` write safety

The config file is read and written on the main extension thread. Write operations use a temp-file-then-rename pattern to avoid corruption:

```typescript
async function updateConfigField(repoRoot: string, key: string, value: unknown): Promise<void> {
  const configPath = path.join(repoRoot, '.legion', 'config.json');
  const existing = JSON.parse(await fs.readFile(configPath, 'utf8').catch(() => '{}'));
  existing[key] = value;
  const tmp = configPath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, configPath);
}
```

### Snooze implementation

"Snooze 1 day" is implemented by writing `last_agenda_drain` to `new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()` — a future timestamp. The next startup check will compare the cron's previous fire time against this future timestamp and find that the drain is NOT overdue, suppressing the notification for one day.

### autoGitCommit integration

After a successful scheduled drain, if `legion.autoGitCommit` is true:

```typescript
const { execSync } = require('child_process');
execSync('git add library/knowledge-base/wiki/', { cwd: repoRoot });
execSync('git commit -m "legion: scheduled agenda drain [skip ci]"', { cwd: repoRoot });
```

The `[skip ci]` suffix prevents infinite CI loops on repos that trigger CI on every commit. This suffix should be configurable via a future setting (`legion.commitMessageSuffix`).

---

## Files Touched

### New files

- `src/driver/cronParser.ts` — `parseCron`, `prevFireTime`, `nextFireTime`, `isOverdue`, `matchesCron`, `fieldMatches`
- `src/driver/cronParser.test.ts` — unit tests covering all field types and the `isOverdue` logic

### Modified files

- `src/extension.ts` — add schedule check in `activate()`: read config, parse cron, call `isOverdue`, show notification if needed
- `src/commands/drainAgenda.ts` — add `last_agenda_drain` timestamp write after successful drain; add post-drain git commit if `autoGitCommit` is set
- `package.json` — add `legion.researchSchedule` and `legion.researchScheduleEnabled` to `contributes.configuration`
- `.legion/config.json` (template in `bundled/` or documentation) — document the `last_agenda_drain` field
- `README.md` — document the scheduled research feature with example cron expressions

### Deleted files

None.

---

## Implementation Plan

### Phase 1 — Cron parser (pure TypeScript, no external deps)

Implement `src/driver/cronParser.ts`:
- `parseCron(expr)` — tokenizes 5-field expression, validates ranges, returns `ParsedCron`
- `matchesCron(cron, date)` — tests a `Date` against all five fields
- `prevFireTime(cron, now)` — backward minute-walk
- `nextFireTime(cron, now)` — forward minute-walk
- `isOverdue(cron, lastRun, now)` — compares `prevFireTime` against `lastRun`

Write `cronParser.test.ts` with at least 30 test cases covering:
- `"0 9 * * 1"` Monday 9am
- `"*/15 * * * *"` every 15 minutes
- `"0 0 1 1 *"` January 1st midnight
- Edge: February dates, day-of-week vs day-of-month interaction

### Phase 2 — Schedule check on activate + notification

In `extension.ts` `activate()`:

```typescript
async function checkResearchSchedule(context: vscode.ExtensionContext, repoRoot: string): Promise<void> {
  const enabled  = vscode.workspace.getConfiguration('legion').get<boolean>('researchScheduleEnabled', false);
  const schedExpr = vscode.workspace.getConfiguration('legion').get<string>('researchSchedule', '');
  if (!enabled || !schedExpr) return;

  let cron: ParsedCron;
  try {
    cron = parseCron(schedExpr);
  } catch (e) {
    outputChannel.appendLine(`[Legion] Invalid cron expression: "${schedExpr}" — schedule disabled`);
    return;
  }

  const config  = await readLegionConfig(repoRoot);
  const lastRun = config.last_agenda_drain ? new Date(config.last_agenda_drain) : null;
  const now     = new Date();

  if (!isOverdue(cron, lastRun, now)) return;

  const agenda = await readFile(path.join(repoRoot, 'library/knowledge-base/wiki/research-agenda.md'));
  if (!hasPendingItems(agenda)) return;

  const lastRunLabel = lastRun ? formatRelativeDate(lastRun) : 'never';
  const choice = await vscode.window.showInformationMessage(
    `Legion: Research agenda drain is due (last run: ${lastRunLabel}). Run now?`,
    'Run Now', 'Snooze 1 day', 'Disable Schedule'
  );

  if (choice === 'Run Now') {
    await vscode.commands.executeCommand('legion.drainAgenda');
  } else if (choice === 'Snooze 1 day') {
    await updateConfigField(repoRoot, 'last_agenda_drain', new Date(Date.now() + 864e5).toISOString());
    vscode.window.showInformationMessage('Legion: Snoozed — next check in ~24 hours.');
  } else if (choice === 'Disable Schedule') {
    await vscode.workspace.getConfiguration('legion').update('researchScheduleEnabled', false, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage('Legion: Research schedule disabled.');
  }
}
```

### Phase 3 — Post-drain timestamp + autoGitCommit

- Modify `drainAgenda.ts` to call `updateConfigField('last_agenda_drain', now.toISOString())` on success
- Add optional `git commit` after drain if `legion.autoGitCommit` is set
- Update `package.json` with new settings

---

## Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Cron parser unit test coverage | 100% branch coverage on all field types | `nyc` / `c8` coverage report |
| `isOverdue` false-negative rate (missed drains) | 0% | All test cases pass |
| Startup overhead from schedule check | ≤ 10ms | Time the `checkResearchSchedule` call in `activate()` |
| User confirmation rate (clicks "Run Now" when notified) | ≥ 60% | Future analytics (PostHog) |

---

## Open Questions

- **Q1:** Should the snooze duration be user-configurable (e.g., `legion.researchSnoozeDays`)? **Current plan:** hardcode 1 day in Phase 1; expose as a setting in a follow-up if users request it.
- **Q2:** Should Legion also check the schedule at a fixed interval during a VS Code session (e.g., every hour) using `setInterval`? **Current plan:** no, check-on-activate only for Phase 1. This covers the most common case (developer opens VS Code in the morning). If users want in-session triggering, add it in a follow-up.
- **Q3:** The `prevFireTime` backward walk is O(minutes) — could be up to 10,080 iterations for a weekly cron. Is this fast enough? **Plan:** 10,080 simple comparisons take < 1ms; verified acceptable. Document the O(n) complexity in code comments.

---

## Risks and Open Questions

- **Risk:** Cron expressions with both `dayOfMonth` and `dayOfWeek` specified have ambiguous semantics (POSIX: OR semantics; Quartz: AND semantics). **Mitigation:** implement OR semantics (fire when either field matches), document this behaviour explicitly, and add a test case.
- **Risk:** The `.legion/config.json` write during a drain could fail if the user's repo is on a read-only filesystem or the file is locked by another process. **Mitigation:** wrap the write in a try/catch; log the error to the output channel and do not block the drain result.
- **Risk:** If the research agenda has 50+ items, a scheduled drain could take > 30 minutes and block VS Code. **Mitigation:** `drainAgenda` already processes items asynchronously with progress reporting; the scheduled trigger is identical to the manual trigger and inherits the same async UX.

---

## Related

- [`feature-002-mcp-server/prd-feature-002-mcp-server.md`](../feature-002-mcp-server/prd-feature-002-mcp-server.md) — the `legion_drain_agenda` MCP tool is the programmatic equivalent of the scheduled trigger
- [`feature-006-pr-review-bot/prd-feature-006-pr-review-bot.md`](../feature-006-pr-review-bot/prd-feature-006-pr-review-bot.md) — both features use the `autoGitCommit` setting; ensure they share the same commit-message pattern
