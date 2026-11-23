# Changelog

## Unreleased

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
