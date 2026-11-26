# Roadmap

Where OpenAgency Social is going. OpenAgency Portal is the control plane it is
normally used with; items that need a change there say so. Released changes are in
[CHANGELOG.md](CHANGELOG.md).

Updated 2026-11-26.

## Done

- A missing permission for one action fails that job, without asking the
  channel for a new login.
- Instagram's failed media downloads retried, `PUBLIC_MEDIA_URL` checked at
  start and on submit, and browser jobs without a runner failing cleanly.
- Worker lanes: video posts and browser jobs have their own slots.
- Revoked logins found before a post is due: a daily token check per
  channel, and background reads that mark a refused token `needs_reauth`.
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
- Deploy-safe publishing: attempts record when the request that makes the
  post visible was sent, a stopping or dead engine's unsent attempts are
  queued again instead of turning uncertain, and shutdown waits a bounded
  grace ([docs/deploy.md](docs/deploy.md)). A person settles an uncertain job
  (`POST /v1/jobs/:id/resolve`). Failures are logged, `jobs.changed` tells
  Portal, and readiness reports whether publishing keeps up.
- Signed webhooks for an organization's own applications: published, failed,
  uncertain and cancelled posts, moving numbers, new comments, posts made elsewhere, profile edits,
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

- Publishing that agencies can rely on:
  - Rate limits: Meta's usage headers read, retries that wait for the limit's
    window, and the app-wide pause the readers set honoured by publishing.
  - Videos checked on submit (size, duration, codec) instead of failing
    after minutes of processing.
  - Posts cancelled by a pause can be brought back when it is lifted.
  - Reconcile that finds a post without an exact caption match, and hidden
    Facebook posts; photos not uploaded again on each retry; longer timeouts
    for uploads and `media_publish`.
  - The platform access each feature needs, documented: which Meta
    permissions need Advanced Access through App Review and Business
    Verification, and the Google project's verification and consent screen.

## Next

- Instagram stories, carousels mixing images and video, a first comment,
  and Facebook video and Reels. Needs Portal.
- Hiding comments.
- Database and role names chosen by the operator. The migrations accept only
  the fixed pairs listed in [docs/deploy.md](docs/deploy.md#database).
- What Portal's social analysis needs from the engine:
  - Statistics for posts made outside OpenAgency on Facebook Pages,
    Instagram and YouTube, so an account is analysed whole. Today only the
    posts the engine published are read; the others only send
    `channel.post.created`.
  - Reads at fixed ages after publishing (one and two days, one and four
    weeks), so posts are compared at the same age.
  - More numbers where a platform's API gives them: profile visits and
    follows a post brought, watch time on reels and videos, and where views
    came from.
  - Audience statistics: when followers are online, and their countries and
    ages.
  - Competitors' public numbers, through the organization's own connected
    channels and official APIs only: Instagram business and creator
    accounts (followers and recent posts with their likes, comments and
    links), YouTube channels (subscribers and each video's numbers), and the
    ads they run from Meta's Ad Library.

## Later

- Competitors' Facebook Pages, once Meta grants the Page Public Content
  Access feature.
- Statistics for TikTok, X, LinkedIn, Threads, Pinterest and Reddit, through
  the official APIs where a platform offers them.
