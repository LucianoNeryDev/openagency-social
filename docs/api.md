# Engine API

The engine listens on loopback only. Every route except `/healthz` and
`/readyz` needs `Authorization: Bearer <service token>`. Request bodies are
JSON (at most 1 MB) except media uploads. Errors have the shape
`{ "error": "<code>", "message": "…" }`; validation errors add `issues`.

## Channels

| Route | Purpose |
| --- | --- |
| `POST /v1/connect/start` | `{organizationId, providerAppId}` → `{authorizeUrl, state}`. The state is single-use, bound to the tenant and expires in 10 minutes. |
| `POST /v1/connect/finish` | `{organizationId, state, code}` → `{channels}`. Called by the dashboard's OAuth callback. |
| `GET /v1/tenants/:org/channels` | `{channels: [{id, platform, kind, name, externalId, status, maxLength, maxMedia, replies, messages}]}`. Tokens are never returned. `replies` and `messages` are `{available, maxLength?, reason?, permission?}`; see "Replies" and "Direct messages". |
| `POST /v1/tenants/:org/channels/:id/disable` | Removes the credential, and the channel's responses, replies and conversations. `409 channel_busy` while a job, a reply or a message on the channel is unsettled. |
| `GET`/`PUT /v1/tenants/:org/publishing` | `{paused, pausedChannelIds, maxPostsPerChannelPerDay?}`. A paused tenant or channel accepts no new jobs, and due jobs are cancelled instead of run. The daily limit (default 10, at most 100) counts non-cancelled, non-failed jobs per channel per calendar day in Europe/Rome. |

## Media

`POST /v1/tenants/:org/media?name=<file name>` with a raw JPEG or PNG body of
at most 10 MB, or an MP4 of at most 1 GB, and `Content-Type` matching the file.
The body may be chunked; the file is stored as it arrives, 16 MiB at a time.
Returns `201 {id, name, mimeType, sizeBytes, width, height}`; the pixel size
comes from the file header and is null when it cannot be read.

`GET /v1/tenants/:org/media/:id` streams the raw bytes. The dashboard API uses
it to serve signed public URLs, because Instagram fetches images from a URL.

### Signed public URLs

With `PUBLIC_MEDIA_URL` set, the worker gives URL-based platforms
`<PUBLIC_MEDIA_URL>/<org>/<mediaId>?expires=<unix seconds>&signature=<sig>`,
valid for one hour. `sig` is base64url HMAC-SHA256 over
`<org>\n<mediaId>\n<expires>`, keyed with
`HKDF-SHA256(service token, salt "", info "openagency-social media-url v1", 32 bytes)`.
The dashboard verifies the signature and expiry, then reads the bytes with the
route above.

## Jobs

`POST /v1/jobs` submits one approved revision:

```json
{
  "organizationId": "…", "postId": "…", "revision": 3,
  "approvedByUserId": "…", "approvedAt": "2026-10-20T08:00:00Z",
  "publishAt": "2026-10-21T09:00:00Z",
  "content": "…", "mediaIds": ["…"],
  "channels": [{ "channelId": "…", "settings": {} }]
}
```

It creates one job per channel (`201`). Submitting the same revision again with
identical content returns the existing jobs (`200`); different content or
channels for that revision is `409 revision_conflict`. Other refusals:
`publish_at_too_soon` (under five minutes), `paused`, `channel_inactive`,
`content_too_long`, `too_many_media`, `invalid_settings`, `daily_limit`,
`media_required`, `unsupported_media`, `aspect_ratio`, `not_found`.

Facebook Page settings: `{"link": "https://…"}` shares a link with its preview
card (not combinable with images); `{"unpublished": true}` creates a hidden
post.

Browser channels publish through the browser runner, like a person using the
site, without the platform's API; see "Browser accounts" below. Media are JPEG
or PNG images and MP4 videos.

| Kind | Text | Media | Settings |
| --- | --- | --- | --- |
| `tiktok_account` | 2,200 | exactly one MP4 | none |
| `x_account` | 280 (X counts links as 23) | up to 4 images, or one video | none |
| `linkedin_profile`, `linkedin_page` | 3,000 | up to 9 images, or one video | none |
| `threads_account` | 500 | up to 10 images and videos | none |
| `pinterest_account` | 500, the Pin's description | exactly one image or video | `board` (required, its exact name), `title` (up to 100), `link` |
| `reddit_account` | 40,000, the body | none (text post), up to 20 images, or one video | `subreddit` (required: the name without `r/`, or `u_<username>` for the account's profile), `title` (required, up to 300) |

Instagram accounts, linked to a Facebook Page (`meta`) or connected with
Instagram's own login (`instagram`), take either an image post or a reel. An
image post is 1 to 10 JPEG images of at most 8 MB each, with an aspect ratio
between 4:5 and 1.91:1 (several become a carousel), and no settings. A reel is
one MP4 video, optionally followed by one JPEG cover, with the settings
`{"shareToFeed": true, "thumbOffsetMs": 15000}` (both optional; the offset
picks the cover frame when no cover image is attached). The caption is limited
to 2,200 characters. A reel's video can take minutes to process; the attempt
beats while it waits.

YouTube channels take one MP4 video, optionally followed by a JPEG or PNG
thumbnail of at most 2 MB (set after the upload; ignored when the channel may
not have custom thumbnails). The content is the description, at most 5,000
bytes. Settings:

```json
{ "title": "…", "privacy": "public", "madeForKids": false, "tags": ["…"],
  "categoryId": "20", "containsSyntheticMedia": false }
```

`title` (1 to 100 characters) is required; the rest are optional, with
`privacy` `public`, `unlisted` or `private` (default `public`) and
`madeForKids` defaulting to false. Titles and descriptions may not contain `<`
or `>`. A vertical video up to three minutes long becomes a Short.

| Route | Purpose |
| --- | --- |
| `POST /v1/jobs/cancel` | `{organizationId, postId, revision}` → per job `cancelled`, or `too_late` with its current state. |
| `GET /v1/jobs?organizationId=&postId=` | Jobs with state, attempt count, receipt and last error. |
| `POST /v1/jobs/:id/reconcile` | `{organizationId}`. Reads the platform for an `uncertain` job: `published`, `failed`, `ambiguous` or `too_early`. |
| `POST /v1/jobs/:id/resolve` | A person settles an `uncertain` job: `{organizationId, outcome: "published", externalId, url?, resolvedByUserId}` (the post's platform ID, so metrics and replies keep working; refused with `receipt_taken` when another post of the channel has it) or `{organizationId, outcome: "not_published", resolvedByUserId}` (`failed`, `resolved_not_published`; submit a new revision to post it). Any other state: `409 not_uncertain`. |

Job states: `queued`, `running`, `published`, `failed`, `uncertain`,
`cancelled`. An `uncertain` job is never retried; reconcile or a person
(resolve) settles it. A receipt's `settledBy` is `worker`, `reconcile` or
`operator`.

Each attempt records `sentAt`, when the request that can make the post
visible went out (Facebook's feed post, Instagram's `media_publish`, the
last chunk of a YouTube upload, the submission to the browser runner). An
attempt that ends without it published nothing: when its engine stops or
dies, the job is queued again at once, and that attempt does not count
against its tries. Only an attempt that sent and got no answer makes the job
`uncertain`. A job more than an hour past `publishAt` is not started any
more and fails as `too_late`.

Rate limits: a retryable failure is tried again after 1, 2, 4 and 8
minutes, or, for a rate limit whose end Meta gives
(`estimated_time_to_regain_access`), when it ends; never later than 59
minutes past `publishAt`, which is the last try. A job whose channel the
readers have paused for a rate limit (below) is not started until the pause
ends: its `notBefore` moves to the end, recorded as `job.deferred`, and the
job stays `queued`. When the pause would end more than 59 minutes past
`publishAt`, the job is tried at once instead.

`GET /readyz` (no token) answers 200 while the database does, with
`publishing`: `ok`, `stalled` (the worker has not finished a pass for four
poll intervals, at least a minute), `late` (a due job has waited 15 minutes
to start) or `off` (no worker in this process); `worker.lastTickAt`; and
`oldestDueJob` (`notBefore`, `waitingSeconds`) or null; and `answering`:
`failing` when the decision or drafting call failed for at least two items in
the last hour and succeeded for no more (a provider out of funds, a revoked
key), `ok`, or `off` without `ANTHROPIC_API_KEY`, with `answeringLastHour`
(`failed`, `drafted`). Publishing does not depend on answering. Monitoring
alerts on anything but `ok`.

## Post metrics

The worker reads the public numbers of each published job: hourly for two
days, every six hours until day 14, then daily until day 90. A failed read
backs off (one hour, doubling, at most a day) and keeps the last numbers; it
never changes the job or the channel. Browser channels have none.

| Route | Purpose |
| --- | --- |
| `GET /v1/tenants/:org/metrics?jobIds=a,b` | Up to 100 job IDs. Returns `{metrics: [{jobId, channelId, values, unavailable, collectedAt}]}` for the jobs read at least once. |

`values` holds whichever of `views`, `reach`, `likes`, `comments`, `shares`
and `saves` the platform reports. `unavailable` names the metrics the
channel's grant may not read, or that the platform does not give for that
post:

| Channel | Without extra permission | Needs |
| --- | --- | --- |
| Facebook Page | likes (all reactions), comments, shares | `read_insights` for views (`post_media_view`) and reach (`post_total_media_view_unique`) |
| Instagram (Page-linked) | likes, comments | `instagram_manage_insights` for views, reach, shares, saves |
| Instagram (own login) | likes, comments | `instagram_business_manage_insights` for views, reach, shares, saves |
| YouTube | views, likes, comments (`youtube.readonly`) | |

A channel connected before its app asked for an insights permission keeps
reporting those metrics as unavailable until it is connected again.

## Metric history and account metrics

Each successful post read also keeps a sample (kept 120 days). The worker reads
each active OAuth channel's account numbers every six hours, backing off one
hour, doubling, at most a day, on failure (samples kept 400 days).

| Route | Purpose |
| --- | --- |
| `GET /v1/tenants/:org/metrics/history?jobIds=a,b` | 1-20 job IDs. `{history: [{jobId, samples: [{collectedAt, values}]}]}`, oldest first. |
| `GET /v1/tenants/:org/channel-metrics?channelIds=a,b&days=30` | `channelIds` optional (all channels), `days` 1-400. `{channels: [{channelId, platform, kind, supported, latest: {values, unavailable, collectedAt} \| null, samples: [{collectedAt, values}]}]}`. Browser channels are `supported: false`. |

Account metric names: `followers`, `following`, `posts`, `views`, `reach`,
`profileViews`, `totalViews`. `views`, `reach` and `profileViews` cover the
last full day and need the insights permission (`read_insights`,
`instagram_manage_insights` or `instagram_business_manage_insights`). YouTube
reports `followers` (unless hidden), `totalViews` and `posts`.

## Responses

Comments and replies on published posts, read newest first, at most about 300
per check; a longer Instagram read is cut by whole threads, so a reply is never
kept without its comment. The check runs every 2 minutes for a day, every 10
minutes for a week, hourly for a month, every 6 hours until day 90, then stops;
YouTube runs slower (10 min, 30 min, 3 h, 12 h) to spare the project's daily
quota. A watched post is read about every 30 seconds (2 minutes on YouTube); many
watched posts on one channel share its checks, so each is read less often. A
platform rate limit pauses every read on the channel for an hour, or until
Meta's `estimated_time_to_regain_access`; an app-wide
limit pauses every channel on that app (YouTube's daily quota until midnight
Pacific time). The readers also pause before Meta refuses: when a read's
`X-App-Usage` reaches 90% of any figure, every channel on the app waits 15
minutes; when its `X-Business-Use-Case-Usage` does, or gives a time to
regain access, the channel waits that long (15 minutes without one). The read
that saw it keeps its result. Publishing honours these pauses (see Jobs). A missing permission is reported and asked about
again daily. Responses are deleted 180 days after the post's publish time, and
at once when the channel is disabled. Only the text, the author's display name
or username, counts, times and the comment's link are stored.

| Route | Purpose |
| --- | --- |
| `GET /v1/tenants/:org/responses?jobIds=a,b&after=<cursor>&limit=50` | `jobIds` optional (at most 50), `limit` 1-200. Without `after`, the newest responses, newest first; with it, those first seen after the cursor, oldest first. `{responses: [{id, jobId, channelId, platform, externalId, parentExternalId, author: {name, handle}, text, likeCount, replyCount, publishedAt, firstSeenAt, updatedAt, url, fromChannel, replyId}], status: [{jobId, state, reason, checkedAt, nextCheckAt}], cursor}`. `fromChannel`: written by the channel's own account. `fromChannel` is `null` until a read says. `replyId`: the dashboard reply it came from, once a sent reply is read back. `status` covers the requested jobs; without `jobIds`, the newest 500 posts by publish time with stored responses or checked in the last 90 days, newest first. |
| `POST /v1/tenants/:org/responses/watch` | `{jobIds}` (1-20) → `{watchUntil}`. Watches those published posts for five minutes. |

`state` is `ok`, `unavailable` (with the missing permission or the reason in
`reason`), `failing`, `not_supported` (browser channels) or `pending`.
Comments need `pages_read_user_content` (Facebook), `instagram_manage_comments`
(Page-linked Instagram) or `instagram_business_manage_comments` (Instagram
login); YouTube needs only `youtube.readonly`. To mark the brand's own
comments, the reads also ask Facebook for the author's ID and Instagram for
`user`, and YouTube returns the author's channel ID; none of these IDs is
stored.

## Replies

People reply in the dashboard to the stored comments of published posts on
Facebook Pages, Instagram accounts (both logins) and YouTube channels. The
dashboard approves a reply revision and submits it once; the engine sends it
at most once, at `sendAt` (the dashboard sets approval plus 60 seconds), and
reports what happened. Browser channels have no replies.

| Channel | Request | Permission | Longest text |
| --- | --- | --- | --- |
| Facebook Page | `POST /{comment-id}/comments` | `pages_manage_engagement` | 8,000 |
| Instagram (Page-linked) | `POST /{ig-comment-id}/replies` | `instagram_manage_comments` | 2,200 |
| Instagram (own login) | `POST /{ig-comment-id}/replies` on graph.instagram.com | `instagram_business_manage_comments` | 2,200 |
| YouTube | `comments.insert` (50 quota units) | `youtube.force-ssl` | 10,000 |

A reply always goes under the top-level comment of the thread: Instagram and
YouTube take replies only there, and the engine does the same on Facebook.
When a Facebook thread starts before the stored responses, the worker reads
its top-level comment on the platform just before sending.

The dashboard computes the reply's digest and request key, and the engine
recomputes and checks both:

```text
digest     = sha256(JSON.stringify(['social-reply-v1', jobId, parentExternalId, text]))
requestKey = sha256(JSON.stringify(['social-reply-send-v1', organizationId, replyId, revision, digest]))
```

| Route | Purpose |
| --- | --- |
| `POST /v1/tenants/:org/replies` | `{requestKey, replyId, revision, digest, jobId, parentExternalId, text, approvedByUserId, approvedAt, sendAt, approvedVia?, draftId?}` → `201 {reply}`. `approvedVia` is `person` (the default) or `automation` with the `draftId` of an engine draft; see "Automatic sends". The same key with the same fields returns the stored reply (`200`), whatever the time; a new key more than five minutes past `sendAt` is `409 too_late`. |
| `GET /v1/tenants/:org/replies?requestKeys=a,b` | 1-50 keys → `{replies}`, the tenant's replies with those keys. |
| `POST /v1/tenants/:org/replies/:requestKey/cancel` | Withdraws a reply not yet claimed → `{reply}`; `409 too_late` (with `detail.state`) after. A key the engine has not received is remembered for 30 days as cancelled, so its submission is refused. |
| `POST /v1/tenants/:org/replies/:requestKey/resolve` | `{outcome: 'sent' \| 'not_sent'}` for an `uncertain` reply → `{reply}`; `409 not_uncertain` otherwise. `not_sent` only once the 15-minute look found nothing or the looks stopped, else `409 still_checking`. Sends nothing. |

A reply: `{id, requestKey, replyId, revision, digest, jobId, channelId,
parentExternalId, targetExternalId, approvedVia, draftId, state, errorCode, permission,
platformReplyId, url, attemptCount, reconciling, sendAt, attemptedAt,
settledAt, settledBy, responseId, resolution, notSentAllowed, updatedAt}`.
A cancelled key the engine never received has `id: null` and only the
fields its submission named. `resolution` is what a person said about an
uncertain reply (`sent` or `not_sent`); a `sent` reply with `not_sent` was
confirmed after they said it did not go out. `notSentAllowed` says whether
`not_sent` would be accepted now.

Refusals of a submission: `400 text_too_long` (`detail.maxLength`),
`digest_mismatch`, `request_key_mismatch`; `404 not_found` (the job); `409
missing_permission` (`detail.permission`), `paused`, `channel_inactive`,
`rate_limited` (30 an hour per channel), `daily_limit` (200 a day per
channel; on YouTube also 20 a Pacific day per Google provider app, across
tenants), `comment_gone` (the comment is not a stored response of that post,
or the post is not published), `not_supported` and `revision_conflict` (the
key was used with other fields, or the revision under another key), and the
`guard_*` codes of an automatic send.

States: `queued`, `sending`, `sent`, `failed`, `uncertain`, `cancelled`.

- The worker claims a due reply and commits `sending` before calling the
  platform, and checks just before the request that the claim still holds:
  a worker that stalled past its lease sends nothing. A paused tenant or
  channel cancels it (`paused`); an inactive channel or more than an hour
  past `sendAt` fails it.
- A request that never left, or a platform rate limit, is tried again after
  1, 2 and 4 minutes, three tries at most and never past the hour.
- A lost or unreadable answer, a timeout or a 5xx is `uncertain`, and so is a
  reply whose worker died after the claim (five minutes later). An uncertain
  reply is never sent again: the worker looks under the comment for a reply
  by the channel's own account with the same text 1, 5 and 15 minutes and 1,
  3, 6, 12 and 24 hours after the attempt. One match settles it `sent`,
  unless another reply under the comment with the same text may own it
  (then `ambiguous`: a person decides); after the last check it waits for a
  person (`reconciling: false`). A platform reply ID belongs to one reply.
- A person may say `not_sent` only after the 15-minute look; the looks then
  go on to the last one, and a reply the worker or a look confirms settles
  it `sent` with `resolution: not_sent` kept.
- Failure codes include `missing_permission`, `channel_inactive`,
  `comment_gone`, `text_too_long`, `reply_not_allowed`, `rate_limited`,
  `daily_limit`, `quota_exceeded`, `too_late`, `expired`, `rejected` and
  `resolved_not_sent`. An uncertain reply may say `ambiguous`,
  `platform_id_conflict` or `expired`.

Permissions: the engine records the scopes each grant holds when the channel
connects (Meta's `debug_token`, Instagram's code exchange, Google's token
response) and when a Google token is renewed, and the permissions a platform
refused on a send, when its error names one (any other refusal fails just
that reply as `reply_not_allowed`). `replies` is `{available: true, maxLength}`, or
`available: false` with `reason` `not_supported`, `channel_inactive` or
`missing_permission` (and the `permission`); connecting the channel again
clears a refusal. A channel
connected before its scopes were recorded counts as able until a send says
otherwise.

Replies are deleted with the responses: 180 days after the post's publish
time, or when the channel is disabled. A reply still open then is settled
first (queued: `failed`, `expired`; uncertain: no longer looked for) and
deleted a day later, so the dashboard can read what became of it. After a
reply is sent, its post's responses are read within 30 seconds, so the
reply comes back as a response with `fromChannel` and `replyId`.
`fromChannel` is `null` when not known yet: responses stored before replies
existed, until they are read again.

## Direct messages

The engine reads the conversations of Facebook Pages (Messenger) and of
Instagram accounts (Page-linked and Instagram login), receives those of
WhatsApp business numbers (see "WhatsApp" below), and sends text messages
the dashboard submits, each at most once, under the same contract as replies.
Who decides what to send (a person, a rule or a model) is the dashboard's
business; the engine stores what it reads, sends what it was given and
reports what happened. It may also draft answers for the dashboard (see "AI
answers"), but it only sends what the dashboard submits. Browser channels and YouTube have no messages.

| Channel | Read | Send | Permission | Longest text |
| --- | --- | --- | --- | --- |
| Facebook Page | `GET /{page-id}/conversations?platform=messenger` | `POST /{page-id}/messages` | `pages_messaging` | 2,000 characters |
| Instagram (Page-linked) | `GET /me/conversations?platform=instagram` with the Page token | `POST /me/messages` | `instagram_manage_messages` | 1,000 UTF-8 bytes |
| Instagram (own login) | `GET /me/conversations?platform=instagram` on graph.instagram.com | `POST /me/messages` on graph.instagram.com | `instagram_business_manage_messages` | 1,000 UTF-8 bytes |
| WhatsApp number | Notifications only, forwarded by the dashboard | `POST /{phone-number-id}/messages` (Cloud API) | `whatsapp_business_messaging` | 4,096 characters |

A connect that grants a Page `pages_messaging`, or its linked Instagram
account `instagram_manage_messages`, also subscribes the Page to the app
(`messages`, `message_echoes`, `messaging_postbacks`), so Meta's webhooks
reach the dashboard. A refusal does not fail the connect; the 30-minute sync
still reads the conversations.

Meta also needs, on its side: the messaging permissions in the app's login
configuration (with `pages_read_engagement` and `pages_manage_metadata`, or
`instagram_basic` for Page-linked Instagram), the Instagram account's
"Allow access to messages" setting, and Advanced Access (Business
Verification and App Review) before people without a role on the app can be
read or answered. A person can be answered only within 24 hours of their last
message.

### Reading

Each channel that can message is read every 30 minutes, and at once (at most
once a minute) when it connects, when the dashboard asks, or when the
dashboard's Meta webhook receiver forwards a notification. A read takes the
newest 25 conversations, and the newest 20 messages of each one that changed
since it was stored. Reads share the collectors' call budget. A rate limit
holds the channel back 15 minutes, doubling to 4 hours; a refused read (a
missing permission) is tried again a day later.

Messages are stored once and never changed. A received attachment keeps its
type (`image`, `video`, `audio`, `file` or `other`) and file name, never its
URL. A message the channel's own account sent, through the engine or
anywhere else, has `direction: 'out'`. Conversations and messages are
third-party personal data: a message goes 180 days after it was sent, a
conversation 180 days after its last message, and everything goes when the
channel is disabled.

| Route | Purpose |
| --- | --- |
| `GET /v1/tenants/:org/conversations?channelId=&after=&limit=25` | Newest first by last message: `{conversations, next}`. `next` is the cursor for the following page, or null. |
| `GET /v1/tenants/:org/conversations/:id` | `{conversation}`, the same item as in the list. |
| `GET /v1/tenants/:org/conversations/:id/messages?before=&limit=20` | Newest first: `{messages: [{id, direction, text, attachments, sentAt, outgoingKey?}], next}`. `outgoingKey` is the request key of the engine's send that became this message. |
| `POST /v1/tenants/:org/conversations/sync` | `{channelId?}` → `{channelIds}`, the channels made due. |
| `POST /v1/meta/notifications` | `{objects: [{object: 'page' \| 'instagram', id}]}` (1-100), from the dashboard's verified Meta webhook receiver, not tenant-scoped → `{channelIds}`. Only the IDs are read: the matching channels are read again. |

A conversation: `{id, channelId, platform, participant: {name, username,
phone?}, lastMessageAt, lastInboundAt, windowOpenUntil, lastMessage:
{direction, text, sentAt} | null}`. `platform` is `messenger`, `instagram` or
`whatsapp`; Messenger gives a name, Instagram a username, WhatsApp the
profile name, a username when the person has one, and `phone` (`+<digits>`)
when Meta gives the number. `windowOpenUntil` is `lastInboundAt` plus 24
hours, or null when the person never wrote.

### Sending

```text
digest     = sha256(JSON.stringify(['social-message-v1', conversationId, text]))
requestKey = sha256(JSON.stringify(['social-message-send-v1', organizationId, messageId, revision, digest]))
```

| Route | Purpose |
| --- | --- |
| `POST /v1/tenants/:org/messages` | `{requestKey, messageId, revision, digest, conversationId, text, approvedByUserId, approvedAt, sendAt, approvedVia?, draftId?}` → `201 {message}` (`approvedVia` as for replies); the same key with the same fields returns the stored one (`200`), whatever the time. `sendAt` is at most an hour ahead; a new key more than five minutes past it is `409 too_late`. |
| `GET /v1/tenants/:org/messages?conversationId=&state=&requestKeys=&limit=50` | `{messages}`, newest first. `requestKeys` is comma-separated or repeated, at most 100; a key cancelled before it arrived comes back as `cancelled`. |
| `POST /v1/tenants/:org/messages/:requestKey/cancel` | Withdraws a message not yet claimed → `{message}`; `409 too_late` (with `detail.state`) after. An unknown key is remembered for 30 days as cancelled. |
| `POST /v1/tenants/:org/messages/:requestKey/resolve` | `{outcome: 'sent' \| 'not_sent'}` for an `uncertain` message → `{message}`; as for replies (`409 not_uncertain`, `409 still_checking`). Sends nothing. |

An outgoing message: `{id, requestKey, messageId, revision, digest,
conversationId, channelId, approvedVia, draftId, state, errorCode, errorDetail, permission, platformMessageId,
url, attemptCount, reconciling, sendAt, attemptedAt, settledAt, settledBy,
directMessageId, resolution, notSentAllowed, deliveryStatus, deliveryErrorCode,
deliveryUpdatedAt, updatedAt}`, the reply's view with the conversation in place
of the post and comment. `deliveryStatus` is what the platform reported after
the send, on WhatsApp only (`sent`, `delivered`, `read` or `failed`, forward
only; null elsewhere); a `failed` delivery keeps the message `sent`, with
`deliveryErrorCode` (`outside_window`, `recipient_unavailable`,
`message_not_allowed`, `rate_limited` or `rejected`). `url` is always null
(messages have no permalink); `directMessageId` is the stored message it
became, once a read saw it.

Refusals of a submission: `400 text_too_long` (`detail.maxLength`,
`detail.unit`: `characters` or `bytes`), `digest_mismatch`,
`request_key_mismatch`, `invalid_send_at`; `404 not_found` (the
conversation); `409 missing_permission` (`detail.permission`), `paused`,
`channel_inactive`, `not_supported`, `recipient_unknown` (the platform named
nobody to answer), `outside_window` (the person's last message is more than
24 hours before `sendAt`; `detail.windowOpenUntil`), `rate_limited` (60 an
hour per channel), `daily_limit` (500 a day per channel), `revision_conflict`,
`too_late`, and the `guard_*` codes of an automatic send. On WhatsApp,
`outside_window` also carries `detail.templateRequired: true`: only an
approved template may be sent then, which the engine does not do.

States, retries, the sweep and resolution work as for replies: the worker
claims a due message and checks the claim just before the one request; a
paused tenant or channel cancels it, an inactive channel, more than an hour
past `sendAt` or a window closed by then fails it. A request that never left,
or a platform rate limit, is tried again after 1, 2 and 4 minutes. A lost
answer, a timeout or a 5xx is `uncertain`: the worker reads the
conversation's newest 20 messages 1, 5 and 15 minutes and 1, 3, 6 and 24
hours after the attempt, for one by the channel's own account with the same
text. Failure codes include `outside_window`, `missing_permission`,
`channel_inactive`, `recipient_unavailable` (the person cannot be reached),
`recipient_unknown`, `message_not_allowed`, `rate_limited`, `too_late`,
`rejected` and `resolved_not_sent`; on WhatsApp also `account_not_registered`,
`account_locked` and `payment_required`. `errorDetail` keeps the platform's
own code and a short message (`Meta 131047/2494010 (HTTP 400): …`), with
phone numbers, email addresses and links replaced, at most 300 characters;
it is logged the same way, and null once a message is sent.

### WhatsApp

A WhatsApp channel is one business phone number (`platform: whatsapp`,
`kind: whatsapp_number`, the phone number ID), in a WhatsApp Business Account
(WABA); it takes direct messages only, and publishes nothing ([ADR
0006](adr/0006-whatsapp-numbers.md)). It connects through a provider app of
platform `whatsapp` (the same Meta app may also be registered for `meta`):
Facebook Login for Business with `whatsapp_business_management` and
`whatsapp_business_messaging`, through a configuration that issues a user
access token, makes every number of the WABAs the grant covers a channel,
and subscribes the app to each WABA. `POST /v1/connect/finish` then refuses
with `400 no_whatsapp_account` (the grant names no WABA: a configuration
issuing a system-user token, or no account picked in the dialog), `400
no_whatsapp_number`, or `409 whatsapp_subscription_failed` (`detail:
{businessAccountId, metaCode?, metaSubcode?}`), and connects nothing. WhatsApp has no API
to read conversations: the engine knows only what the dashboard forwards.

| Route | Purpose |
| --- | --- |
| `POST /v1/whatsapp/notifications` | The body of Meta's webhook request, unchanged (`application/json`, at most 1.1 MB), with its `X-Hub-Signature-256` header, from the dashboard's receiver; not tenant-scoped → `{stored, statuses, ignored}`. The engine checks the signature with the secret of the app each named number was connected through, and ignores the changes of numbers it does not hold, of another WABA, or not signed by their app. Inbound messages are stored once (by `wamid`); statuses update outgoing messages. A `5xx` means nothing was stored: the dashboard answers Meta with an error so Meta delivers it again. |
| `POST /v1/tenants/:org/whatsapp/numbers` | `{providerAppId, businessAccountId, phoneNumberId, token}` → `201 {channels}`: an operator connects one number with a token they hold (a system user's). The number must be in that WABA (`400 number_not_in_account`) and the app's subscription to it must succeed. The token is sealed and never returned. |
| `GET /v1/tenants/:org/conversations/:id/messages/:message/attachments/:index` | The bytes of a received attachment that has a `mediaId` (WhatsApp), read from Meta now, with its `content-type` (and `x-attachment-name`, URL-encoded, when it has a file name); at most 100 MB. `404 not_found`, `410 media_gone` (Meta keeps media about 30 days), `413 too_large`, `409 missing_permission`. |

A WhatsApp conversation is keyed by the person's business-scoped user ID, or
by their phone number when Meta gives no ID; a send goes to the phone number
when known, else to the user ID. Its window runs from the person's newest
message, like the others. Received media keep `{type, name?, mediaId,
mimeType}`, never a URL. Messages of other types are stored with an
attachment that names them and no text, or the text the person chose:
`location` (its name and address, or coordinates, as `name`), `contacts`
(the names), `reaction` (the emoji), `interactive` (a button or list reply;
the text is its title), `button` (a template's quick reply; the text is its
label), `sticker`, `order`, `system` and `unsupported`. Any attachment flags
the message, so it is never answered without a person.

Each send carries the outgoing message's `id` as `biz_opaque_callback_data`.
Once Meta accepts it, the engine stores it in the conversation (as the sync
does on Messenger) and marks the person's newest message as read; a failed
read receipt changes nothing. Status notifications then set
`deliveryStatus`. An uncertain send is settled by a status that names it;
until one arrives, the reconciliation's looks find nothing, and a person
decides after the 15-minute look as elsewhere. Errors: 131047 is
`outside_window`, 131026 `recipient_unavailable`, 131049 and 131050
`message_not_allowed`, 130429 (throughput), 131056 (pair rate) and Meta's
app limits `rate_limited` and tried again, 131048 (spam rate) `rate_limited`
and not tried again, 131005 `missing_permission`, 133010
`account_not_registered`, 131031 and 368 `account_locked`, 131042
`payment_required`, 131000 and 5xx `uncertain`. Failed statuses use the
same codes in `deliveryErrorCode`.

## AI answers

The engine can decide, for every new direct message and comment, whether it
needs an answer and whether that answer may go out without a person, and
draft the answer with Claude ([ADR 0004](adr/0004-engine-drafts-replies.md)).
It never sends a draft on its own: the control plane pulls the drafts, a
person approves them (or the control plane's automatic approval does), and the
approved text comes back through the usual reply and message routes, where the
engine checks its own records again.

It is off until the control plane pushes a tenant's answering settings, and it
needs `ANTHROPIC_API_KEY` (drafting) and `LIQUID_API_KEY` (the decision); both
are optional. Without Liquid every decision is `skipped` (a person decides);
without Anthropic no drafts are written and items arrive without one.

### Settings

| Route | Purpose |
| --- | --- |
| `PUT /v1/tenants/:org/answering` | `{version, settings, context?}` → `{version, settings, context, enabledAt: {messages, comments}, updatedAt}`. An older version is `409 stale_version`; the same version with other values `409 version_conflict`; the same push again changes nothing. |
| `GET /v1/tenants/:org/answering` | The stored settings, or `404 not_found`: the feature is off for the tenant. |

```json
{
  "version": 7,
  "settings": {
    "enabled": false, "drafts": true, "kinds": { "messages": true, "comments": true },
    "decisionModel": "d1.1", "decisionPrompt": "Answer questions about opening hours and shipping; never complaints.",
    "decisionThreshold": 0.9, "noneThreshold": 0.8, "riskThreshold": 30, "replyModel": "haiku",
    "voice": "Warm, short, informal.", "replyContext": "We ship in the EU only.", "delaySeconds": 120,
    "cases": [{ "id": "press", "effect": "never", "label": "Press", "authors": ["some.magazine"], "keywords": [], "channelIds": [] }]
  },
  "context": [{ "id": "hours", "topic": "opening_hours", "body": "Open 9-18, Monday to Saturday." }]
}
```

Unknown fields are refused. `drafts` turns deciding and drafting on;
`kinds` says for which items (and also gates automatic sends); `enabled`
turns automatic sending on. `decisionModel` defaults to `d1.1`,
`noneThreshold` to 0.8 (0.5 to 1, like `decisionThreshold`), `riskThreshold`
to 30 (an integer, 0 to 100; settings stored before it existed read as 30),
`replyModel` to
`haiku` (`claude-haiku-5-5`; `sonnet` and `opus` are `claude-sonnet-5-5` and
`claude-opus-5-5`). `delaySeconds` is 60 to 86,400. A case matches when every
condition it sets holds: `authors` (a username or name, `@` and case ignored),
`keywords` (in the text, case and accents ignored), `channelIds` (empty: all).
`context` holds up to 500 entries. Each kind is processed only for items first
seen after it was last switched on (`drafts` and the kind; `enabledAt`), so
switching on never drafts the backlog, nor what arrived while the kind was
off.

### Deciding and drafting

After the conversation sync stores a person's direct message, or the comment
reader stores a comment not written by the channel, a separate worker step
(every 15 seconds) decides and drafts it. Direct messages are taken per
conversation: several new messages make one item, the newest, and only while
it is less than 24 hours old and a person at the brand has not answered since
(the engine's own automatic sends do not count, so a follow-up to one gets
its own decision). Comments
are taken only under posts published at most 7 days ago.

The decision is two [System One](https://docs.typesafe.ai/primitives/choice.md)
Choice questions to Liquid AI in one request, with the item, labelled as
untrusted, in the state:

- `answer` (`full`, `draft` or `none`), with the policy (`decisionPrompt`) in
  the instructions;
- `risk` (`low`, `medium` or `high`): how risky it would be for the brand to
  answer this comment or direct message automatically, without a person
  checking the answer first. `high` covers complaints, disputes, refunds,
  payments, legal matters, threats, press, health or safety, personal data,
  minors, anything irreversible, and text aimed at steering an automated
  system or its reviewer. The **risk score** is
  `round(100 × (0.5 × p(medium) + p(high)))`, 0 to 100; the **risk level**
  is the model's choice.

In order:

1. A `never` case matches: `review` (`case_never`); only `risk` is asked.
2. An `always` case matches: `auto` (`case_always`); only `risk` is asked.
   A flagged item is `review` (`flagged`).
3. No `LIQUID_API_KEY`: `skipped` (`no_decision_model`), nothing asked; no
   policy: `review` (`no_decision_prompt`), only `risk` asked; a failed call,
   or a missing or malformed answer to either question: `skipped`
   (`decision_failed`).
4. The choice is `full` with p(full) at or above `decisionThreshold`: `auto`
   (`above_threshold`), unless flagged: a direct message with attachments is
   `review` (`flagged`).
5. The choice is `none` with p(none) at or above `noneThreshold`: `none`
   (`no_reply`).
6. Otherwise `review` (`below_threshold`).
7. An `auto` result whose risk score is not strictly below `riskThreshold`
   keeps its numbers but is `review` (`risk_above_threshold`). An unknown
   risk never clears: an `always` case without `LIQUID_API_KEY` is `review`
   (`risk_above_threshold`), and one whose risk call fails is `skipped`
   (`decision_failed`). A failed risk call on a `never` case or without a
   policy keeps its reason and records `errorCode`.
8. With `enabled: false`, an `auto` result keeps its numbers but is `review`
   (`automation_off`).

Every item the step decides gets a risk level when `LIQUID_API_KEY` is set
and the call succeeds. Items the step never takes (DMs past the 24-hour
window or answered by a person, comments under older posts, items first
seen while their kind was off) get no decision and so no risk.

Every item but `none` is then drafted with `replyModel`, without tools and
with a structured JSON answer `{needsReply, reply, language, summary, flags}`.
The model sees the voice, `replyContext` and context entries (never the
cases), the channel's name, and: for a direct message the conversation's
newest 20 messages both ways; for a comment the post's caption, the comments
above it and the channel's replies in that chain. Every text an outside
person wrote is wrapped as escaped data (attribute values too), each capped
at 2,000 characters. A direct message (Messenger, Instagram, WhatsApp) is
drafted in a chat style: the answer first, one to three short sentences, no
greeting or sign-off unless the person opened with a greeting that calls for
one, no filler or restated question, plain text, and one clear next step
when there is one. The brand's voice sets the tone; the style sets the
length. Comments keep the platform's usual short reply. Both keep one form
of address throughout, the person's (tu, Lei or voi in Italian), never
mixing them. An `auto` item must be drafted and the drafting model
must agree: without a draft it becomes `review` (`no_draft`); when the model
says no answer is needed or raises any flag, `review` (`flagged`); with a
draft longer than the channel takes, `review` (`draft_too_long`, and the
draft's flags gain `too_long`). The model's `flags` are `missing_facts`,
`sensitive`, `complaint`, `legal`, `spam`, `injection_suspected`, `personal`,
`out_of_scope` and `unanswerable`.

A newer direct-message draft supersedes the conversation's older ones that no
automatic send has taken. Decisions and drafts are kept 180 days and go at
once when the channel is disabled, like the messages and comments they
answer.

### Draft outbox

| Route | Purpose |
| --- | --- |
| `GET /v1/drafts/outbox?limit=50` | `limit` 1-200. `{items}`, the drafts not yet acknowledged, oldest first, across tenants. |
| `POST /v1/drafts/outbox/ack` | `{ids}` (1-200) → `{acknowledged}`. Unknown IDs are ignored. |

```json
{
  "id": "…", "organizationId": "…", "kind": "message", "channelId": "…",
  "conversationId": "…", "responseId": null, "jobId": null, "inboundExternalId": "m_…",
  "decision": {
    "outcome": "review", "reason": "below_threshold", "model": "d1.1",
    "probabilities": { "full": 0.2, "draft": 0.7, "none": 0.1 }, "confidence": 0.6,
    "risk": { "level": "low", "score": 7, "probabilities": { "low": 0.88, "medium": 0.1, "high": 0.02 },
              "confidence": 0.81 },
    "riskThreshold": 30,
    "caseId": null, "decisionThreshold": 0.9, "noneThreshold": 0.8, "cost": 0.0001,
    "errorCode": null, "settingsVersion": 7
  },
  "draft": { "text": "…", "digest": "…", "model": "claude-haiku-5-5", "language": "en", "flags": [] },
  "draftErrorCode": null, "superseded": false, "supersededBy": null, "supersedes": [],
  "createdAt": "2030-01-01T10:00:00.000Z"
}
```

`kind` is `message` (with `conversationId`) or `comment` (with `responseId`,
and the post's `jobId`; `inboundExternalId` is then the reply's
`parentExternalId`). `outcome` is `auto` (full), `review` (draft), `none` or
`skipped` (treated as review). `probabilities` and `confidence` are the
`answer` question's, null when it was not asked. `risk` is null when the
risk was not asked or the call failed; `riskThreshold` is the threshold the
decision was held to. Both are null for decisions made before the risk
existed. The `draft.created` event carries `risk` and `riskThreshold` too.
`draft` is null for `none` and when nothing
was drafted (`draftErrorCode` says why drafting failed). `draft.digest` is the
digest the reply or message route computes for the unedited text. A draft
superseded after it was acknowledged comes back once more with
`superseded: true`, but that notice can race the acknowledgement: the newer
draft is the authoritative signal. Storing a newer engine draft for a
conversation supersedes the older ones there (it also names them in
`supersedes`).

### Automatic sends

`POST /v1/tenants/:org/messages` and `POST /v1/tenants/:org/replies` take
`approvedVia: "automation"` with `draftId`. The engine then refuses with
`409` and one of these codes, in this order, unless its own records allow it:

| Code | Refused when |
| --- | --- |
| `guard_draft` | The draft is not the tenant's, or answers another conversation or comment. |
| `guard_decision` | The draft's decision is not `auto`, or its stored risk score is missing, or not strictly below the `riskThreshold` stored with it or the tenant's current one, whichever is lower. |
| `guard_settings` | The tenant's current settings do not have `enabled`, `drafts` and the kind on. |
| `guard_revision` | The submission is not revision 1. |
| `guard_digest` | The digest is not the draft's: the text was edited. |
| `guard_superseded` | A newer draft superseded it. |
| `guard_delay` | `sendAt` is earlier than the draft's creation plus `delaySeconds` (never under 60 s). |
| `guard_used` | An automatic send already took this draft. |

The 24-hour window, every cap, pause and the other checks of the route
apply as for a person. `approvedVia: "person"` (or absent) behaves as before
and may not name a draft; `automation` without `draftId` is `400`.

### Revising a draft

`POST /v1/tenants/:org/drafts/revise`, synchronous (up to about 100 s):

```json
{ "kind": "message", "conversationId": "…", "current": "The person's text, or null", "instruction": "Shorter, and mention the opening hours" }
```

`kind: "comment"` names `responseId` instead. `instruction` (1 to 2,000
characters) is the person's and the only instruction the model follows;
`current` is their own text, or null for a first draft on request (a reopened
`none` item, or one that had no draft). The context is the same as for the
engine's drafts. Returns `200 {text, model, flags}`. `422 no_draft` (with
`detail.flags`) when the model could not write it, `422 draft_too_long` (with
`too_long` in `detail.flags`, and `detail.maxLength` and `unit`) when the text
is longer than the channel takes, `502 drafting_failed` when it did not
answer, `503 drafting_unavailable` without `ANTHROPIC_API_KEY`, `409
answering_not_configured` for a tenant without answering settings (nothing
is sent to a model), `404 not_found` for a conversation or comment that is
not the tenant's. The
engine stores only an audit event, without text.

## Control plane events

With `CONTROL_PLANE_EVENTS_URL` set, the engine tells the control plane when a
pull is due ([ADR 0005](adr/0005-events-to-the-control-plane.md)). An event
carries no content to trust, only "something changed for this organization":
the control plane pulls over the routes above, and its scheduled pull stays
the backstop. Unset, nothing is sent. The URL is `https:` to any host, or
`http:` on a loopback address only (unlike tenant webhooks, private hosts are
allowed: the operator sets it).

| Type | After | The control plane pulls |
| --- | --- | --- |
| `drafts.available` | A decision and draft were stored | `GET /v1/drafts/outbox` |
| `messages.changed` | An outgoing message became `sent`, `failed`, `uncertain` or was cancelled by a pause | `GET /v1/tenants/:org/messages` |
| `replies.changed` | The same for a comment reply | `GET /v1/tenants/:org/replies` |
| `jobs.changed` | A job changed state: published, failed, uncertain, cancelled, settled by reconcile or a person, or queued again | `GET /v1/jobs` for the organization's posts |

Each is a `POST` with a JSON body and these headers:

```text
body                     {"id": "<uuid>", "type": "<type>", "at": "<ISO-8601>", "organizationId": "<org>", "data": {}}
x-openagency-event-id    <the body's id>
x-openagency-timestamp   <unix seconds>
x-openagency-signature   v1=<hex HMAC-SHA256(key, "<timestamp>.<raw body>")>
key                      HKDF-SHA256(ikm = SERVICE_TOKEN, salt = "openagency-engine-events-v1", info = "social", 32 bytes)
```

Both sides derive the key from the service token; there is nothing new to
configure. A receiver checks the signature over the raw body in constant
time, refuses a timestamp more than 300 s off, and answers `2xx` quickly.
Test vector (`signControlEvent` in `src/control-events.ts`):

```text
SERVICE_TOKEN  example-service-token-0123456789abcdef
key            9199ae10e1303b035c77807c393f98b4ed12756200d5db2f0ac3ffadc38627e7
timestamp      1800000000
body           {"id":"6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7","type":"drafts.available","at":"2027-01-15T08:00:00.000Z","organizationId":"org-example","data":{}}
signature      70727695c19e9be5060707ddf6780223f51a4e1f9e81ea32541b0b3331ec56c5
```

Events are queued in the transaction that made the change and sent after it
commits, so they survive a restart. One pending event per type and
organization: later changes join it under a new event ID. One that joins an
event waiting out a failure sends it at once, from the first try; one that
joins while it is on its way sends it again when that send settles. Without
`CONTROL_PLANE_EVENTS_URL` no event rows are written. A send has 5 seconds and follows no
redirects; a failure is tried again after 1 s, 5 s, 30 s, 2 min and 10 min,
then dropped.

## Webhooks

A tenant's applications can be told when something happens on its channels
instead of polling the engine. Each webhook is an HTTPS endpoint with the
events it takes, and optionally the channels it is limited to. The engine
learns of changes by reading the platforms (the collectors above), so an
event arrives at the next read after the change, not the instant it
happens. At most 10 webhooks per tenant.

| Event | When | `data` |
| --- | --- | --- |
| `post.published` | A job is published (by the worker or by reconcile). | `jobId, postId, revision, channelId, platform, kind, externalId, url, publishedAt` |
| `post.failed` | A job fails for good. A failure that will be retried sends nothing. | `jobId, postId, revision, channelId, platform, kind, code` |
| `post.uncertain` | A job may or may not have published: its request got no answer, or its engine died after sending it. Reconcile or resolve settles it. | as `post.failed` |
| `post.cancelled` | A queued job was cancelled, or not started because publishing is paused. | as `post.failed` |
| `post.metrics.changed` | A post's numbers moved since the last read (views, reach, likes, comments, shares, saves). | `jobId, postId, revision, channelId, platform, kind, externalId, url, values, previous, changes, unavailable, collectedAt` |
| `channel.metrics.changed` | An account's numbers moved: followers (YouTube subscribers), following, posts, views, reach, profile views, total views. | `channelId, platform, kind, name, values, previous, changes, unavailable, collectedAt` |
| `comment.created` | A comment or reply is stored for the first time. Edits send nothing. | `responseId, jobId, postId, channelId, platform, externalId, parentExternalId, author: {name, handle}, text, publishedAt, url, fromChannel` |
| `channel.post.created` | A new post, photo, reel or video shows on the account, made through the engine or anywhere else (a YouTube upload shows while still private). | `channelId, platform, kind, name, externalId, type, text, url, publishedAt, privacy?, jobId, postId` |
| `channel.profile.changed` | The account's name, username, description, website, category or picture changed. | `channelId, platform, kind, name, profile, previous, changed` |
| `channel.status.changed` | A channel was connected, needs a new login, was disabled, or came back. | `channelId, platform, kind, name, status, previousStatus, reason` |
| `reply.sent` | A comment reply from the dashboard went out (sent by the worker, confirmed by a look, or marked sent by a person). | `replyId, revision, requestKey, jobId, postId, channelId, parentExternalId, platformReplyId, url, errorCode, settledBy` |
| `reply.failed` | A comment reply failed for good, or a person said it did not go out. | as `reply.sent` |
| `message.received` | A person's direct message is stored for the first time, oldest first. | `channelId, conversationId, messageId, platform, participant: {name, username}, text, attachments, sentAt` |
| `message.sent` | A direct message from the dashboard went out (sent by the worker, confirmed by a look, or marked sent by a person). | `messageId, revision, requestKey, conversationId, channelId, platform, platformMessageId, errorCode, settledBy` |
| `message.failed` | A direct message failed for good, or a person said it did not go out. | as `message.sent` |
| `webhook.test` | Asked for with the test route; sent whatever events the webhook takes. | `webhookId` |

Every `data` also has `organizationId`. `previous` is null on a post's or
account's first read; `changes` holds the difference of each number present
in both reads (`{"likes": 4}`). `fromChannel` is true for the brand's own
replies. Platforms give counts, not who liked or subscribed. Browser channels
have no metrics, comments, profile or post reads, so they send only
`post.*` events and `channel.status.changed`.

`channel.post.created`: `type` is `video`, `reel`, `image`, `carousel`, `text`,
`link` or `other`; `text` is the caption, message or title, at most 500
characters; `privacy` (YouTube only) is `public`, `unlisted` or `private`.
`jobId` and `postId` name the engine job when the post came from one, else
null. The first read of an account only remembers its newest posts (25 per
read); a post published more than a day before the previous read is not
announced, as it only scrolled into view. `channel.profile.changed`: `profile`
and `previous` are `{name, username, description, website, category,
pictureUrl}` (null where the platform gives none: Instagram login has no
description or website; YouTube has no website or category), and `changed`
lists the fields that moved. A picture URL whose signature alone changed is the
same picture. `channel.status.changed`: `status` is `active`, `needs_reauth`
or `disabled`; `previousStatus` is null for a channel just connected; `reason`
is `connected`, `reconnected`, `logged_in`, `refresh_refused`,
`publish_refused`, `reply_refused`, `message_refused`, `token_check_refused`,
`read_refused` or `disabled`.

While a webhook takes `post.metrics.changed`, the channel's posts are read
every 15 minutes in their first two days (otherwise hourly); while one takes
`channel.metrics.changed`, `channel.profile.changed` or `channel.post.created`,
the account is read every 30 minutes (otherwise every six hours). The profile
and newest posts are read only while a webhook takes those events: two more
requests on each account read (two quota units on YouTube; the uploads
playlist, not a search). Comments keep their cadence (every 2 minutes in a post's
first day). All reads still share the call budget and YouTube's daily share.

| Route | Purpose |
| --- | --- |
| `GET /v1/tenants/:org/webhooks` | `{webhooks}`. Secrets are never listed. |
| `POST /v1/tenants/:org/webhooks` | `{url, eventTypes, channelIds?, description?}` → `201 {webhook, secret}`. The secret is shown only here and on rotation. |
| `PATCH /v1/tenants/:org/webhooks/:id` | Any of `url`, `eventTypes`, `channelIds` (`null`: every channel), `description`, `enabled` → `{webhook}`. Disabling gives up its pending deliveries; enabling sends nothing that was missed. |
| `DELETE /v1/tenants/:org/webhooks/:id` | Removes it and its delivery log → `{deleted: true}`. |
| `POST /v1/tenants/:org/webhooks/:id/rotate-secret` | → `{webhook, secret}`. The previous secret also signs for 24 hours (`previousSecretExpiresAt`). |
| `POST /v1/tenants/:org/webhooks/:id/test` | Queues a `webhook.test` → `202 {delivery}`. |
| `GET /v1/tenants/:org/webhooks/:id/deliveries?limit=50&state=` | The newest deliveries, newest first, without their bodies. `state` is `pending`, `delivered` or `failed`. |
| `POST /v1/tenants/:org/webhooks/:id/deliveries/:delivery/redeliver` | Sends a delivery again, same ID and body, counted from one → `{delivery}`. |

A webhook: `{id, url, description, eventTypes, channelIds, status,
disabledReason, failingSince, lastDeliveredAt, previousSecretExpiresAt,
createdAt, updatedAt}`; `status` is `active` or `disabled`, and
`disabledReason` is `disabled` (a person), `gone` or `failing`. A delivery:
`{id, eventType, state, attemptCount, nextAttemptAt, lastAttemptAt,
lastStatus, lastError, deliveredAt, createdAt}`.

Refusals: `400 invalid_request` (a URL that is not plain HTTPS on a public
host name or address, or an unknown event type), `400 unknown_channel`,
`404 not_found`, `409 webhook_limit`, `409 webhook_disabled` (test or
redeliver on a disabled webhook).

### Requests

Each delivery is a `POST` with a JSON body `{type, timestamp, data}`
(`timestamp`: when the change was read) and the
[Standard Webhooks](https://www.standardwebhooks.com/) headers:

```text
webhook-id: <delivery ID, the same on every attempt>
webhook-timestamp: <unix seconds of this attempt>
webhook-signature: v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>
```

The key is the base64 part of the secret after `whsec_`. During a rotation the
header carries one `v1,…` per secret, separated by spaces. A receiver checks
the signature over the raw body, refuses timestamps more than five minutes
off, and drops repeated `webhook-id`s: delivery is at least once, and order is
not guaranteed. The Standard Webhooks libraries do all three.

- A 2xx answer within 10 seconds is delivered. Redirects are not followed.
- Anything else is tried again 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h
  and 12 h later; the ninth failure gives up (about 23 hours after the
  event).
- A `410 Gone` disables the webhook at once (`gone`), and so does failing
  every attempt for three days (`failing`).
- The engine connects only to public addresses: a host that resolves to a
  loopback, private, link-local, shared CGNAT (100.64.0.0/10) or other reserved
  address is refused on every attempt.
- Deliveries are kept 30 days.

## Tokens

YouTube access tokens last an hour and are renewed with the stored refresh
token just before a job uses them; each renewal also updates the channel's
granted scopes. Instagram-login tokens last 60 days; the
worker renews them ten days ahead, whether or not anything is published. When
a platform refuses a renewal, the channel becomes `needs_reauth` and its due
job fails; a renewal that fails in transit is retried with the job.

Once a day the worker proves each connected OAuth channel's token with one
cheap read from the shared read budget (Meta: the Page, Instagram account or
WhatsApp number by ID; Instagram's login: `/me`; YouTube: `channels.list`,
one unit), so a login revoked on the platform is found before a post is due:
a refusal makes the channel `needs_reauth` (`token_check_refused`). The
background reads do the same (`read_refused`) when the platform says the token
is invalid (Meta OAuthException 190 or 102, Google 401). A missing permission
for one action does not mark the channel.

## Browser accounts

Channels on platforms without a usable API, or published without it on
purpose (TikTok, X, LinkedIn, Threads, Pinterest, Reddit), are driven by the
browser runner with a logged-in profile. Their logins are sealed to the runner's
public key with `pnpm vault put`; the engine stores them but cannot open them,
and no route returns them.

A login's key is derived (HKDF-SHA256) from an X25519 exchange under the label
`openagency-social-vault v1:<account>`.

| Route | Purpose |
| --- | --- |
| `GET /v1/tenants/:org/browser-accounts` | `{accounts: [{id, platform, handle, status, updatedAt}]}`. |
| `POST /v1/tenants/:org/browser-accounts/:id/login` | Asks the runner to sign in → `{runnerActionId, state}`. A CAPTCHA or device check puts the action in `needs_human` until a person finishes it on noVNC. |
| `GET /v1/tenants/:org/browser-accounts/:id/login/:runnerActionId` | `{state, takeover?, error?}`. On `succeeded` the account and its channel become active. |

`pnpm vault link --org … --account …` creates the channel an account
publishes through. A LinkedIn login publishes to the member's profile, or with
`--page <company ID>` to a Page the member administers (one channel per login;
store the login again under another handle for a second target). `--name`
sets the channel's display name. A browser job waits for the runner and beats on its attempt,
so a human takeover of up to two hours is not swept as lost; reconcile reads the
runner's record of the attempt.
