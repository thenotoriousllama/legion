# Security Audit Report: Legion v1.2.0 — SecretStorage Migration

**Audit date:** 2026-05-02  
**Auditor:** security-guardian subagent  
**Scope:** `src/util/secretStore.ts`, `src/extension.ts` (onDidChangeConfiguration handler + startup migration call), `src/commands/setupWizard.ts` (`promptForKey`), `src/util/keyPrompt.ts` (`promptAndSaveKey`)  
**Extension version:** 1.2.0 (VS Code extension — not a Next.js/React app)  
**Stack note:** This is a VS Code extension (TypeScript / Node.js). The OWASP Top 10:2025 Next.js-specific patterns (CSP headers, RSC data leakage, middleware bypass) do not apply directly. The audit focuses on secret-handling correctness, PII-in-logs patterns, data-loss atomicity, and dependency CVEs.  
**CVE watchlist:** The 2026-04-30 security audit used the current watchlist. No Next.js or React CVEs apply to this VS Code extension directly (the `undici`/`tar` findings below are transitive via `@cursor/sdk`).

---

## Executive Summary

The SecretStorage migration implementation is **structurally sound**: resolution chain precedence is correct, migration atomicity preserves keys on failure, password fields are properly masked in VS Code UI, and VS Code's per-extension SecretStorage scoping prevents namespace collisions. No Critical or High findings were detected. Three Medium findings were identified and fixed in-session: (1) `maskSecret` returned the full value for strings ≤ 4 chars due to an unchecked zero-`hiddenLen` path; (2) the `onDidChangeConfiguration` handler had no error handling — a silent SecretStorage failure would leave API keys in plaintext `settings.json` without any user notification; (3) `promptForKey` showed the raw first-8 characters of an existing key in its placeholder instead of using the canonical `maskSecret`. The dependency scan surfaces 7 High advisories in `@cursor/sdk`'s transitive tree (`undici`, `tar`), all inherited and none exploitable through the extension's own code paths.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Secret Handling / PII Exposure | ATTN | 3 Medium (all fixed) |
| Authentication & Authorization | OK | None detected |
| Injection Vulnerabilities | OK | None detected |
| Dependency Security | ATTN | 7 High (transitive via `@cursor/sdk` — see below) |
| Migration Atomicity / Data Loss | OK | None detected |
| Input Validation | OK | None detected |
| Logging / Notification Leakage | OK | None detected |

Legend: **OK** = zero findings · **ATTN** = Medium/Low findings (3 fixed in-session; dependency Highs are transitive) · **FAIL** = Critical/High in extension code (none).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings (fixed in-session)

- [x] **maskSecret — full-value exposure on short strings** `src/util/secretStore.ts:149-156`  
  When `prefix.length + 4 >= value.length`, `hiddenLen` resolved to 0, causing the function to return `prefix + visible` — which can equal the full key for strings ≤ 4 characters (no underscore) or certain short prefixed strings. `getSetupState` passes masked values to the sidebar webview; a short key stored via settings.json migration (no UI length guard) would be returned unredacted. **Fix applied:** Added an early branch for `hiddenLen === 0` that falls back to showing only the last 2 characters with bullet-padded prefix, ensuring no full-value leakage regardless of length.

- [x] **onDidChangeConfiguration — unhandled SecretStorage failure** `src/extension.ts:159-165`  
  The `onDidChangeConfiguration` handler had no try/catch. If `setSecret` threw (e.g., OS SecretStorage unavailable — possible on some Linux setups without libsecret), the VS Code extension host would silently swallow the exception. The `cfg.update` calls to clear settings.json would not execute, leaving the key in plaintext settings.json. Critically, the user would receive **no notification** — they would believe the key had been moved to encrypted storage when it had not. **Fix applied:** Wrapped the handler body in try/catch; on failure a `showWarningMessage` informs the user the key was retained in settings.json and suggests reloading the window.

- [x] **promptForKey — first-8-char leak in InputBox placeholder** `src/commands/setupWizard.ts:226-228`  
  When an existing key was present, the placeholder showed `Current: ${existing.slice(0, 8)}•••`. This reveals the first 8 characters of the key rather than using the canonical `maskSecret` function (which shows prefix + bullets + last-4). For some key formats (e.g., Cursor API keys with a user-specific prefix after `cursor_`) this could disclose identifying information. `password: true` masks typed input but does **not** mask placeholder text. **Fix applied:** Replaced `existing.slice(0, 8)•••` with `maskSecret(existing)` (also added `maskSecret` to the import).

---

## Low Findings (documentation only)

- [ ] **Silent migration failure in activate()** `src/extension.ts:257`  
  `migrateSettingsKeysToSecretStorage(context).catch(() => undefined)` swallows all errors. If the migration fails (e.g., SecretStorage write error), no log or notification is emitted and the MIGRATION_FLAG is not set, so the migration retries on next activation — which is the correct recovery path. However, persistent failure is completely invisible. **Recommendation:** Log to an output channel on failure so users and bug reporters can diagnose OS-level SecretStorage issues.

- [ ] **promptAndSaveKey returns raw secret to caller** `src/util/keyPrompt.ts:106`  
  The function returns the plaintext secret value to callers. Within the audited files no caller misuses this return value, but it increases the attack surface: a future caller could accidentally log or display it. **Recommendation:** Callers that need the stored value should call `getSecret()` subsequently rather than consuming the return value of `promptAndSaveKey`. Consider returning `boolean` instead of `string | undefined`.

- [x] **Misleading comment in migrateSettingsKeysToSecretStorage** `src/util/secretStore.ts:189` (comment fix applied in-session)  
  The original comment `"Clear from settings.json regardless of whether we wrote (it's plaintext either way)"` could mislead a future developer into thinking the intent was to clear even after a failed `store()` call — a potential data-loss regression if someone added a catch block. **Fix applied:** Clarified that `store()` throwing means control never reaches the clear lines, preserving settings.json on failure.

---

## INFO Findings (all pass)

These concerns were explicitly checked and found to be correctly handled:

1. **globalState migration flag** (`MIGRATION_FLAG` in `context.globalState`) — Correct placement. VS Code's extension host isolates each extension's `globalState`; other extensions cannot read it. SecretStorage is the right place for secrets; globalState is the right place for boolean state flags.

2. **SecretStorage namespace collision** — Keys stored as `legion.secret.<key>` are automatically prefixed with the extension's ID by VS Code's underlying SecretStorage implementation (DPAPI/Keychain/libsecret). No cross-extension collision is possible.

3. **Env-var precedence** (`getSecret`, `src/util/secretStore.ts:85-108`) — Resolution chain is correctly implemented: env vars → `context.secrets.get(NS + key)` → `cfg.get<string>(key, "")` (legacy settings.json). Documented and matches implementation.

4. **Migration atomicity** (`migrateSettingsKeysToSecretStorage`, `src/util/secretStore.ts:171-198`) — SecretStorage is written (`context.secrets.store`) **before** settings.json is cleared (`cfg.update → undefined`). If `store()` throws, the `cfg.update` lines are never reached (exception propagation), so settings.json is preserved. If `store()` succeeds but the process crashes before `cfg.update`, the key exists in both places; on next activation the migration re-runs, finds the existing SecretStorage value, skips the write, and clears settings.json. No data-loss path exists.

5. **Password masking in InputBox** (`promptForKey`, `promptAndSaveKey`) — Both use `password: true`. The `validateInput` callbacks in both functions return only error message strings (or `undefined`) and never echo the secret value `v`. No logging of `v` occurs.

6. **No plaintext in notifications/error messages** — All `showInformationMessage` and `showWarningMessage` calls in the audited files reference key labels (e.g., `"Cursor API key"`) or the `key` name string (e.g., `"cursorApiKey"`), never the actual secret value. `setSecret`'s throw path includes only the key name, not the value.

---

## Dependency Audit

```
npm audit --audit-level=high output (2026-05-02):

10 vulnerabilities (2 low, 1 moderate, 7 high)

HIGH advisories:
  tar ≤7.5.10 — 6 advisories: Arbitrary File Creation/Overwrite via Hardlink Path
    Traversal, Symlink Poisoning, Race Condition (GHSA-34x7, GHSA-8qq5, GHSA-83g3,
    GHSA-qffp, GHSA-9ppj, GHSA-r6q2). Via: node-gyp → make-fetch-happen → cacache.
    Root consumer: sqlite3 (via @cursor/sdk).
  undici ≤6.23.0 — 5 advisories: unbounded decompression, HTTP smuggling,
    WebSocket memory consumption, invalid server_max_window_bits, CRLF injection
    (GHSA-g9mf, GHSA-2mjp, GHSA-vrm6, GHSA-v9p9, GHSA-4992). Via @connectrpc/connect-node.
    Root consumer: @cursor/sdk.
```

**Assessment:** All 7 High advisories are transitive through `@cursor/sdk`. The `tar` vulnerabilities require the attacker to control archive extraction — not exposed by Legion's code paths. The `undici` vulnerabilities require active use of `undici` for HTTP requests — Legion uses `@cursor/sdk`'s SDK surface only (agent invocation), not raw HTTP via undici. **No exploitable path through extension code was identified.** Track `@cursor/sdk` releases and upgrade when a patched version is available.

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/util/secretStore.ts` | `maskSecret`: add `hiddenLen === 0` guard to prevent full-value exposure on short strings; clarify atomicity comment |
| `src/extension.ts` | `onDidChangeConfiguration`: wrap handler in try/catch with user-facing warning on SecretStorage failure; import `SECRET_KEYS` |
| `src/commands/setupWizard.ts` | `promptForKey`: replace `existing.slice(0, 8)•••` placeholder with `maskSecret(existing)`; import `maskSecret` |

`git diff` reviewed on 2026-05-02. Diff contains only security-relevant changes — no opportunistic refactoring.

---

## Recommended Follow-Up (architectural)

1. **`promptAndSaveKey` return type** — Change return type from `Promise<string | undefined>` to `Promise<boolean>` (motivated by the LOW finding at `src/util/keyPrompt.ts:106`). This eliminates the attack surface of passing raw secrets around in the call graph.

2. **Migration failure observability** — On persistent SecretStorage failure in `migrateSettingsKeysToSecretStorage`, write a structured entry to a named VS Code output channel (e.g., `"Legion: Setup"`) so users can diagnose platform-level issues without needing to enable developer tools (motivated by LOW finding at `src/extension.ts:257`).

3. **`@cursor/sdk` dependency pinning** — Track upstream patching of `undici` and `tar` advisories. When `@cursor/sdk` ships a version with patched transitive deps, bump it. Add a renovate or dependabot rule to alert on new `@cursor/sdk` releases.

---

## Ordering Note

This audit ran **before** `quality-guardian` as required. The existing QA report at `library/qa/2026-04-30-qa-report.md` predates the most recent commit (`6d99f59`, 2026-05-02 04:59 UTC-4) and does not cover the new files in this session. The three in-session file edits (secretStore.ts, extension.ts, setupWizard.ts) should be included in `quality-guardian`'s next pass.

---

*Generated by `security-guardian` using `security-weapon`. See `.cursor/skills/security-weapon/` for methodology.*
