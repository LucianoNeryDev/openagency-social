# Changelog

## Unreleased

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
