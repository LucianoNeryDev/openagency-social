# OpenAgency Social — Domain Context

## Purpose

The engine executes social media actions that the control plane (dashboard) has
already authorized, and reports the result back. It has no client-facing UI and
makes no approval decisions.

## Core language

- **Tenant** — a dashboard organization. The engine stores the dashboard
  organization ID; it never creates or authorizes tenants itself.
- **Platform** — a social network family with one API surface: `meta`
  (Facebook Pages and the Instagram accounts linked to them), `instagram`
  (Instagram accounts connected with Instagram's own login, without a Page),
  `youtube`, and the browser platforms `tiktok`, `x`, `linkedin`, `threads`,
  `pinterest` and `reddit`.
- **Provider app** — a developer application registered on a platform (a Meta
  app, an X project, a TikTok app). It has an owner: one tenant, or the agency
  when it is shared. Its secret is stored outside the database and referenced
  by name.
- **Channel** — one connected account on a platform (a Facebook Page, an
  Instagram professional account, an X user). A channel belongs to exactly one
  tenant and was authorized through exactly one provider app.
- **Channel credential** — the token (and refresh token) a channel's owner
  granted through OAuth, or imported from another publisher by an operator.
  Encrypted at rest; never returned by the engine's API.
- **Action** — something done on a channel: `publish_post`, `publish_story`,
  `publish_reel`, `reply_comment`, `send_message`, and so on.
- **Capability** — whether a platform adapter supports an action, and through
  which driver.
- **Driver** — how an action is carried out: `api` (official platform API) or
  `browser` (a logged-in browser session). Only `api` exists in the first
  phase.
- **Job** — one requested action for one approved dashboard revision on one
  channel. The pair (dashboard post ID, revision, channel) is unique, so the
  same revision can never be queued twice.
- **Attempt** — one try at executing a job, with its start, end and outcome.
- **Receipt** — the platform's identifier for what was created (a post ID and,
  when available, a permalink).
- **Uncertain** — the outcome of an attempt whose effect is unknown: a timeout
  or a lost response after the request was sent. Uncertain jobs and replies
  are never retried automatically; they are reconciled by reading the
  platform, or settled by a person.
- **Response** — a comment or reply on a published post, read by the
  collector. Third-party content: stored only to show it, and deleted 180
  days after the post's publish time. A response written by the channel's own
  account is the brand's.
- **Reply** — one approved revision of the dashboard's answer to a response,
  sent at most once under the top-level comment of its thread. Its **request
  key** binds the organization, the dashboard reply and revision, and the
  digest of the post, the answered comment and the text; the engine accepts
  each key once. A reply can be cancelled until the worker claims it.
- **Resolution** — what a person said about an uncertain reply: sent, or not
  sent once the 15-minute look found nothing. A reply found later still
  settles as sent; the resolution stays as the record of the conflict.
- **Rival** — another reply under the same comment with the same text that
  may own a match: reconciliation then leaves both to a person.
- **Conversation** — a Messenger or Instagram thread between a channel and
  one person (the **participant**), read by the conversation sync. Its
  messages (**direct messages**) are third-party content, stored once and
  deleted 180 days after they were sent.
- **Answering window** — the 24 hours after the participant's last message,
  within which Meta lets the channel answer.
- **Outgoing message** — one submitted revision of a direct message from the
  dashboard, sent at most once under the reply contract (request key,
  tombstones, claim, reconciliation, resolution).
- **Webhook** — a tenant's HTTPS endpoint and the events it takes
  (published and failed posts, moving numbers, new comments, new posts on
  the account, profile edits, channel status, sent and failed replies,
  received, sent and failed direct messages),
  optionally for some of its channels only. Signed with a secret only the endpoint and the engine hold.
- **Delivery** — one event for one webhook, queued in the transaction that
  made the change, and sent at least once with retries; its ID lets the
  receiver drop repeats.
- **Answering settings** — what the dashboard pushed for a tenant: whether
  the engine decides and drafts (`drafts`), for which kinds (DMs, comments),
  whether automatic sending is on (`enabled`), the policy, thresholds,
  voice, preprogrammed context and **cases** (`always` or `never`, matched
  on the author or keywords). No settings: the feature is off.
- **Decision** — what the engine concluded about one inbound DM or comment:
  `auto` (full: may be answered without a person), `review` (draft: a person
  checks), `none` (needs no answer) or `skipped` (not decided; a person
  decides), with the reason and the model's probabilities.
- **Engine draft** — the answer the engine wrote for a decided item, with the
  digest its unedited submission would carry. A newer draft for the same
  conversation **supersedes** older ones. Drafts reach the dashboard through
  the **draft outbox**.
- **Automatic send** — a reply or message the dashboard approved
  automatically (`approvedVia: automation`) for an engine draft. The engine
  refuses it unless its own records pass every **guard**.
- **Control event** — a signed nudge to the dashboard that a pull is due
  (new drafts, message or reply receipts). It carries no content.
- **Granted scopes** — the permissions a channel's grant holds, as the
  platform reported them at connect or renewal; **refused scopes** are those
  a platform refused on a send with an error that names them. Together they
  say whether a channel can reply.

## Boundaries

- The dashboard decides; the engine executes. A job is only accepted for a
  revision the dashboard reports as approved.
- Pause is enforced in both places: the dashboard stops submitting, and the
  engine refuses to start an attempt for a paused tenant or channel.
- Incoming platform content (comments, DMs) is untrusted input. Whatever reads
  it does not hold publishing tools: the conversation sync has no sending
  code. Replies are written and approved by people in the dashboard; direct
  messages may also come from the dashboard's rules or models. The engine
  only sends what it was given.
- The engine may decide and draft answers (ADR 0004), in a step separate
  from the readers that holds no sending code and writes only drafts. The
  dashboard still approves every send; an automatic approval passes the
  engine's own guards. In every model prompt, inbound text is data, never
  instructions.
