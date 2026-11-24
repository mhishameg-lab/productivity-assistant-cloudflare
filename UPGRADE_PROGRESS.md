# Telegram v4 Upgrade Progress

## Status reconciliation

The nine stage test runs passed, but that did not mean every v4 acceptance
criterion was implemented. This record was reconciled during the final
production-readiness review on 2026-11-24. V4 remains partially implemented;
disabled features must not be described as production-ready.

## Stage status

### Stage 1: Foundation — Partial

- Cairo formatting, display settings, and additive schema exist.
- The stored area values and callback identifiers remain unchanged.

### Stage 2: Voice engine and companion state — Partial

- Tone selection and companion tables exist.
- Companion interval, ignored-response backoff, and wake re-ping behavior are
  incomplete. The production Companion gate remains off.

### Stage 3: Calm Mode — Partial

- HQ aliases, task stack, and response formatting exist.
- Duplicate command branches have been removed during the final review.

### Stage 4: User reminders — Partial

- Reminder parsing, storage, and explicit actions exist.
- Delivery is not ready for activation: retry/lease and downtime semantics are
  incomplete. The production reminder gate remains off; commands now refuse to
  create reminders that cannot be delivered.

### Stage 5: Mini App — Blocked

- Init-data validation, API routes, and page scaffolds exist.
- CSP nonce and form submission defects were fixed during final review.
- Rest and Settings remain placeholders, and complete Mini App user journeys
  have not been verified. The production Mini App gate remains off.

### Stage 6: Night wrap and morning — Partial

- The Cairo-local schedule dispatcher and daily rhythm are present.
- The full requested wake-time and downtime behavior depends on the incomplete
  Companion implementation.

### Stage 7: Companion mode — Blocked

- Dive/sleep state and parsing exist, including corrected Cairo DST handling.
- Check-in cadence, backoff, sleep hold, and wake retry semantics remain
  incomplete. Production Companion controls remain off.

### Stage 8: Pipeline explainer — Partial

- The schedule map and read-only explainer exist.
- Interactive pipeline settings and full consistency controls are incomplete.

### Stage 9: Polished emails — Partial

- Multipart text/HTML generation, encoding, escaping, and size limits are
  covered by tests.
- Production email presentation and delivery have not been end-to-end verified;
  no test or manual production email was sent.

## Final-review fixes

- Added per-response CSP nonces for Mini App scripts and corrected form
  submission handling.
- Reused the DST-aware Cairo local-time conversion for reminders and sleep;
  nonexistent local times are rejected.
- Made reminder request IDs return the original persisted reminder on retry and
  logged uncertain Telegram delivery instead of swallowing failures.
- Gated reminder, Companion, and work-pulse commands when their delivery
  features are disabled.
- Treated Telegram's `message is not modified` response as a successful no-op
  to avoid duplicate fallback messages.
- Removed unreachable duplicate assistant command branches.
- Restored the production Calendar read/write gates to off because production
  logs showed Google API `accessNotConfigured` failures.
- Connected scheduled overdue-task reminders to `TASK_REMINDERS_ENABLED`.

## Remaining production limitations

- Mini App, user reminders, Companion, work pulses, and HTML email remain
  disabled in production until their full journeys and recovery behavior are
  completed.
- Google Calendar remains disabled until its API is enabled and access is
  verified; no production event was created.
- Production email escalations/reports have not been manually tested.
- A Git push previously resulted in a staging-configured version reaching the
  production Worker. Release verification must confirm the production
  environment after every push; the external Cloudflare build configuration
  still needs review.
- The full current test suite passed after the final-review changes. A green
  suite does not substitute for external integration verification.
