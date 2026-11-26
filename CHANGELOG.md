# Changelog

## Unreleased

- Videos checked on submit: an MP4's `moov` box is read as the upload
  arrives (`mvhd` duration, the video track's display size after rotation
  and its codec, the sound track's codec), stored on `media` (migration
  `0023`, nullable `duration_ms`, `video_codec`, `audio_codec`) and
  returned by the upload. Submit refuses an Instagram reel that is not
  H.264 or HEVC with AAC, shorter than 3 seconds, longer than 15 minutes or
  over 300 MB, and a YouTube video without a video track, in an uncommon
  codec or over 12 hours, with `video_too_large`, `video_too_short`,
  `video_too_long` or `unsupported_codec`. Videos stored before are checked
  for size only.
- Rate limits: the Graph client reads Meta's `X-App-Usage` and
  `X-Business-Use-Case-Usage` headers on every answer. A background read
  (post and account numbers, comments, account activity) that sees any
  figure at 90% or more, or a time to regain access, keeps its result and
  pauses the channel (the whole app for the app's own figures) for Meta's
  estimate or 15 minutes, before Meta starts refusing. A refused read pauses
  until `estimated_time_to_regain_access` when Meta gives it. A rate-limited
  publish is retried when the limit lifts (`retryAt`), and any retry is
  scheduled no later than 59 minutes past `publishAt`, as a last try instead
  of failing `too_late`. A job whose channel is paused for a rate limit is
  not started until the pause ends (`notBefore` moves, event `job.deferred`),
  unless that is more than 59 minutes past `publishAt`: then it is tried.
- A missing permission for one action no longer marks the whole channel as
  needing a new login: Meta's codes 10 and 200-299 and YouTube's
  `insufficientPermissions`, `forbidden` and `youtubeSignupRequired` fail the
  job as `permission_missing`; only an invalid token (Meta 190 or 102,
  Google 401 or `authError`) is `auth` with a new login.
- Instagram's failed media download (subcodes 2207003, 2207020, 2207052, on
  the container request or its status) is retried as `media_download_failed`
  instead of failing for good. A post with media for Instagram or a browser
  channel is refused at submit (`public_media_unavailable`) when
  `PUBLIC_MEDIA_URL` is not set, and the engine says at start when the
  address is unset or does not answer. A job whose platform this engine does
  not run (a browser channel without `RUNNER_URL`) fails as
  `platform_unavailable` instead of turning uncertain.
- Worker lanes: each job gets a lane at submit (`standard`, `video` for any
  MP4, `browser` for browser channels; migration `0022` adds `jobs.lane` and
  sets it for queued and running jobs), and each lane has its own slots
  (`WORKER_CONCURRENCY` for standard posts, `WORKER_VIDEO_SLOTS` and
  `WORKER_BROWSER_SLOTS`, default 1 each), so a few reels or a browser
  session cannot hold photo posts past the one-hour lateness limit.
- Revoked logins found before a post is due: a daily token check reads each
  connected OAuth channel once (`checkCredential`: the Page or account ID on
  Meta, `/me` on Instagram's login, the number on WhatsApp, `channels.list`
  on YouTube) from the shared read budget, and a refused token marks the
  channel `needs_reauth` (`token_check_refused`), which sends
  `channel.status.changed`. Channels keep `tokenCheckedAt` (migration `0021`,
  a nullable column). The background readers (post and account metrics,
  comments, account activity, conversations) mark the channel the same way
  (`read_refused`) when Meta answers OAuthException 190 or 102, or Google 401;
  a missing permission does not.
- Deploy-safe publishing: attempts record `sentAt`, when the request that can
  make the post visible went out (migration `0020`, a nullable column).
  Adapters call `beforeVisible` right before it; a closed attempt sends
  nothing. A stopping engine waits `SHUTDOWN_GRACE_MS` (default 25 s), and
  half way queues again the jobs whose attempts had not sent; a dead
  engine's unsent attempts are queued again by the sweeper instead of turning
  `uncertain`. Interrupted attempts do not count against a job's tries.
  docs/deploy.md gives the stop timeout to set.
- A person settles an uncertain job: `POST /v1/jobs/:id/resolve` with
  `published` (and the platform ID) or `not_published`, recorded with who
  decided; receipts may be `settledBy: operator`.
- Failures visible: failed attempts are logged at `warn`, uncertain ones at
  `error`, claim-time failures (`too_late`, `channel_inactive`) at `warn`; a
  `jobs.changed` control event after any job state change; webhooks
  `post.uncertain` and `post.cancelled`; `/readyz` reports `publishing`
  (`ok`, `stalled`, `late`, `off`), the worker's last pass and the oldest due
  job, and `answering` (`failing` after two failed AI calls in an hour with
  none drafted).

- Risk gate for automatic answers ([ADR 0004](docs/adr/0004-engine-drafts-replies.md#amendment-risk-gate)):
  the decision request also asks `risk` (`low`, `medium`, `high`) in the
  same call, or alone for `never` and `always` cases and without a policy.
  The risk score is `round(100 × (0.5 × p(medium) + p(high)))`. `auto` now
  needs a score strictly below the new setting `riskThreshold` (0 to 100,
  default 30), on every path; otherwise `review` with
  `risk_above_threshold`. An unknown risk never clears, so an `always`
  case without `LIQUID_API_KEY` goes to a person. Decisions keep `risk`
  and `riskThreshold` (migration `0019`, nullable columns) and carry them
  in the outbox and the `draft.created` event; `guard_decision` refuses an
  automatic send whose stored risk is missing or at or above its stored
  threshold, or the current one when lower.

- WhatsApp fixes from the staging test: a connect now fails with a code that
  says why instead of connecting nothing silently: `no_whatsapp_account`
  (the grant names no business account, as with a Login for Business
  configuration that issues a system-user token: it must issue a user
  access token), `no_whatsapp_number`, or `whatsapp_subscription_failed`
  (Meta refused the webhook subscription; Meta's code in `detail`), on the
  OAuth path as on the manual one. ADR 0006 and the deploy notes now say the
  configuration must issue a user access token.
- Outgoing messages keep `errorDetail`: the platform's code, subcode and a
  short message with phone numbers, emails and links removed (migration
  `0018`, a nullable column); failed attempts are logged at `warn` with it.
  WhatsApp maps 133010 to `account_not_registered`, 131031 and 368 to
  `account_locked` and 131042 to `payment_required`, for sends and failed
  statuses.
- Drafts keep one form of address throughout, the person's (tu, Lei or
  voi), in direct messages and comments.

- WhatsApp business numbers as message-only channels ([ADR
  0006](docs/adr/0006-whatsapp-numbers.md)): platform `whatsapp`, kind
  `whatsapp_number`, messaging platform `whatsapp`. Login for Business
  connects every number of the granted business accounts and subscribes the
  app; `POST /v1/tenants/:org/whatsapp/numbers` connects one number with an
  operator's token. `POST /v1/whatsapp/notifications` takes Meta's webhook
  body and signature from the dashboard, checks the signature with the
  channel's own app, and stores messages once (by `wamid`). Sends carry the
  outgoing ID in `biz_opaque_callback_data`, are stored in the conversation,
  mark the person's message read, and follow Meta's statuses
  (`deliveryStatus`, `deliveryErrorCode` and `deliveryUpdatedAt` on outgoing
  messages); a status that names an uncertain send settles it. Received
  media are read from Meta on request
  (`GET …/messages/:message/attachments/:index`). Outside the 24-hour window
  `outside_window` carries `templateRequired: true`; templates are not sent.
  Conversations gain `participant.phone` on WhatsApp. Migration `0017`
  widens the platform, kind and messaging-platform checks and adds
  `channels.parent_external_id` and four nullable columns to
  `outgoing_messages`. No new configuration.
- Drafts of direct messages (Messenger, Instagram, WhatsApp) follow a chat
  style: the answer first, one to three short sentences, no greeting or
  sign-off unless the person's greeting calls for one, no filler or restated
  question, plain text, one clear next step. Comment replies keep their
  style.

- Rename wave 4, the complete cut of the old names.
  - Migrations no longer name a database or a role. Every grant goes to the
    roles named by the database settings `openagency.migrator_role`,
    `openagency.runtime_role` and the optional `openagency.backup_role`, which
    the operator sets once per database (`ALTER DATABASE … SET`); a migration
    fails with the setting's name when one is missing or names a role that
    does not exist, and refuses to run as any role but the migrator. The
    historical migrations were edited to match, `0016` included (it copied the
    grants of `conversations`). Databases that already ran them are unaffected:
    drizzle applies a migration by its journal timestamp and never re-reads an
    applied file. The suite's own names are now `openagency_social[_<env>]`
    with `social_{migrator,runtime,backup}[_<env>]` ([docs/deploy.md](docs/deploy.md#database)).
  - The browser vault opens only logins sealed under `openagency-social-vault
    v1:<account>`; the `leonessa-vault v1` fallback and `vault reseal` are
    gone. Run `vault reseal` with the previous version before deploying this
    one, or store the logins again with `vault put`.
  - The runner's data directory defaults to `/var/lib/openagency-social-runner`
    with no fallback to the old directory.
  - The database tests read only `SOCIAL_TEST_POSTGRES_URL`, no longer remove
    containers with the old `banditore-test` label, and create a backup role to
    check its grants; a new suite checks the settings from a fresh database.
  - The brand files (`docs/brand/social-*`) carry the OpenAgency Social
    wordmark.
- The browser vault's HKDF info label is now `openagency-social-vault
  v1:<account>` (was `leonessa-vault v1:<account>`). Logins are always sealed
  under the new label; the runner opens either, trying the new one first, and
  fails as before when neither authenticates. The stored format and the
  associated data are unchanged. New `vault reseal [--dry-run] [--batch-size
  n]` re-seals stored logins still under the old label, in small
  transactions, and is idempotent; run it once this version is deployed,
  staging first ([docs/deploy.md](docs/deploy.md)). Release the runner before
  the engine: an older runner cannot open logins sealed under the new label.
- Rename wave 3a, names read by other systems (the receiving side accepts both
  names; nothing the engine sends changes): the CI database variable is now
  `SOCIAL_TEST_POSTGRES_URL` (workflow, README and CONTRIBUTING; the test
  fixture still falls back to `BANDITORE_TEST_POSTGRES_URL`), and the runner's
  default `RUNNER_DATA_DIR` is `/var/lib/openagency-social-runner`. While
  `RUNNER_DATA_DIR` is unset and the old default `/var/lib/leonessa-browser-runner`
  exists but the new one does not, the runner keeps using the old directory and
  logs it once, so an existing runner keeps its data. The old directory
  fallback and the old variable name are dropped in wave 3c.
- Rename wave 3b, senders switch to the new names. Events to the control plane
  are sent with `x-openagency-event-id`, `x-openagency-timestamp` and
  `x-openagency-signature`, signed with the key derived from the salt
  `openagency-engine-events-v1` (info `social` and the `v1=<hex>` HMAC format
  are unchanged), and media URLs are signed with the HKDF info
  `openagency-social media-url v1`. Merge only after the control plane (Portal)
  accepts these names in production: it refuses them until then. The pinned
  test vectors (events key and signature, media signature) were recomputed.
- Renamed the remaining Banditore names: repository links
  (`github.com/LucianoNeryDev/openagency-social`), the `package.json`
  `repository` URL, the brand files (`docs/brand/social-*`) and the database
  test container label (`social-test=postgres`; the fixture's cleanup also
  removes containers that still carry the old `banditore-test` label).
  Environment variables (`BANDITORE_TEST_POSTGRES_URL`), headers, signing
  contexts, migrations and database names are unchanged.
- Renamed the project from Banditore to OpenAgency Social, the social engine of
  OpenAgency (formerly Comune); the control plane, Palazzo, is now OpenAgency
  Portal. Only names in prose, image labels and the npm package name
  (`openagency-social`) changed, and webhooks now send the user agent
  `OpenAgency-Social-Webhooks/1`. Webhook payloads and event types, the
  `x-comune-*` event headers and the signing key derivation, environment
  variables, database names and job types are unchanged.
- Renamed the project to Banditore.
- AI answers: per-tenant answering settings (`PUT /v1/tenants/:org/answering`);
  a worker step that decides every new DM and comment (full, draft or none,
  with Liquid AI's System One) and drafts an answer with Claude; a draft
  outbox for the control plane; automatic sends of engine drafts through the
  reply and message routes (`approvedVia: "automation"`, `draftId`) behind
  `guard_*` checks; and `POST /v1/tenants/:org/drafts/revise`. Optional
  `ANTHROPIC_API_KEY` and `LIQUID_API_KEY`.
- Signed events to the control plane (`drafts.available`, `messages.changed`,
  `replies.changed`) when `CONTROL_PLANE_EVENTS_URL` is set.
- Replies and outgoing messages report `approvedVia` and `draftId`.

## 0.1.0 — 2026-11-13

First public release.

- Publishing to Facebook Pages, Instagram (through a Page or Instagram's own
  login) and YouTube through their APIs, with per-tenant provider apps.
- Publishing to TikTok, X, LinkedIn, Threads, Pinterest and Reddit through the
  browser runner, with sealed logins and noVNC takeover.
- Account and post statistics, comment reads and approved replies, direct
  messages on Facebook Pages and Instagram.
- Signed webhooks for posts, numbers, comments, profile edits, channel status,
  replies and messages.
