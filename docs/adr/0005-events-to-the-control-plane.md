# ADR 0005: Signed events tell the control plane when to pull

- Status: Accepted
- Date: 2026-11-15
- Note (2026-11-23, rename wave 3b): the headers are now `x-openagency-*` and the salt `openagency-engine-events-v1`; this ADR otherwise keeps the former names (`x-comune-*`, `comune-engine-events-v1`).

## Context

The control plane learns what changed by polling: drafts, sent and failed
messages and replies. With drafts that may be approved within a minute, and
people waiting for a notification on their phone, a poll every minute is
slow, and polling faster costs both sides for nothing most of the time.

The engine listens on loopback only and the control plane must not trust
anything the engine sends it beyond what its own authenticated pulls return.

## Decision

The engine sends the control plane small signed events that only say "pull
now for this organization".

- Optional `CONTROL_PLANE_EVENTS_URL`: `https:` to any host, or `http:` on a
  loopback address. Unlike tenant webhooks, private hosts are allowed: the
  operator configures it, not a tenant. Unset, nothing is sent.
- Types: `drafts.available`, `messages.changed`, `replies.changed`. The body
  is `{id, type, at, organizationId, data: {}}`; no content.
- The key is derived from the existing service token (HKDF-SHA256, salt
  `comune-engine-events-v1`, info `social`); the signature is a hex
  HMAC-SHA256 over `<timestamp>.<body>`. Nothing new to configure or rotate.
- Events are written to a `control_events` table in the transaction that
  made the change, one row per (type, organization), and sent after the
  commit: they coalesce, and survive a restart. A change that joins a row
  gets a new event ID: it is sent at once when the row waits out a failure,
  and again after the send that is on its way. Without a URL no rows are
  written.
- A send has 5 s and follows no redirects; failures are retried after 1 s,
  5 s, 30 s, 2 min and 10 min, then dropped: the scheduled pull covers it.

## Consequences

- Drafts and receipts reach the control plane within about a second.
- Losing events loses nothing but speed; the pull routes stay the source of
  truth and the schedule stays the backstop.
- The table holds at most three rows per tenant.
- Rotating the service token rotates the event key on both sides at once.
