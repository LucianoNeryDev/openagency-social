# Roadmap

Where OpenAgency Social is going. OpenAgency Portal is the control plane it is
normally used with; items that need a change there say so. Released changes are in
[CHANGELOG.md](CHANGELOG.md).

Updated 2026-11-23.

## Done

- Publishing to Facebook Pages, Instagram (images, carousels and reels,
  through a Page or Instagram's own login) and YouTube through their APIs,
  with pause, cancel, receipts, retries and token renewal.
- Provider apps per tenant: each channel records the app it was authorized
  through, so a client can bring its own Meta or Google app
  ([ADR 0002](docs/adr/0002-per-tenant-provider-apps.md)).
- A browser runner for platforms without a usable API: TikTok, X, LinkedIn
  (profiles and Pages), Threads, Pinterest and Reddit, posting through the
  website. One persistent profile per account, logins sealed to the runner,
  and a person can take over at login checkpoints.
- Statistics: follower, view and reach history per channel, and each post's
  likes, comments, shares, reach, views and saves, refreshed on a schedule and
  more often while someone is looking.
- Comments on published posts, and replies approved in Portal, sent once on
  Facebook Pages, Instagram and YouTube within per-channel limits.
- Direct messages on Facebook Pages and Instagram: conversations read, and
  messages sent once within the 24-hour window and per-channel limits.
- Signed webhooks for an organization's own applications: published and failed
  posts, moving numbers, new comments, posts made elsewhere, profile edits,
  channel status, replies and messages.
- Postiz replaced (2026-11-02), with an operator import for the channels that
  came from it ([ADR 0001](docs/adr/0001-own-engine-replaces-postiz.md)).
- First public release, 0.1.0 (2026-11-13), and the rename to OpenAgency Social
  (2026-11-23).

## Now

- AI answers for direct messages and comments. A decision model sorts each
  new message or comment into answer automatically, draft for a person, or no
  answer needed; a model drafts the reply with the conversation as context.
  Portal approves, and Social checks its own records again before any
  automatic send.
- Revising a draft from a person's instruction ("make it shorter").
- Events to Portal: a signed nudge when drafts, messages or reply receipts
  change, so Portal reads them at once instead of on its schedule.

## Next

- Hiding comments.
- Database and role names chosen by the operator. The migrations accept only
  the fixed pairs listed in [docs/deploy.md](docs/deploy.md#database).
