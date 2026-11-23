<img src="docs/brand/social-icon.svg" alt="" width="96" height="96">

# OpenAgency Social

OpenAgency Social is the social engine of OpenAgency, a self-hosted suite for
running a digital agency. It publishes and manages social media for many
clients at once: it posts, reads statistics and comments, sends approved
replies and direct messages, and tells your applications what happened through
signed webhooks.

The engine is the execution layer only. A control plane (your dashboard or
app) owns tenants, drafts, approval and audit, and sends the engine approved
work over an authenticated HTTP API. The engine executes it and reports
receipts.

```
control plane ── approved revision ──► engine ──► platform APIs (Meta, YouTube)
      ▲                                  │
      │                                  └──────► browser runner (TikTok, X, LinkedIn,
      └────────── receipts, status, webhooks ──── Threads, Pinterest, Reddit)
```

## What it does

| Platform | Publishing | Statistics | Comments and replies | Direct messages |
| --- | --- | --- | --- | --- |
| Facebook Pages | Text, image and link posts | Account and posts | Read and reply | Messenger |
| Instagram (through a Page or Instagram's own login) | Images, carousels, reels | Account and posts | Read and reply | Yes |
| YouTube | Videos | Channel and videos | Read and reply | — |
| TikTok, X, LinkedIn (profiles and Pages), Threads, Pinterest, Reddit | Through the browser runner | — | — | — |

Across all of them:

- **Per-tenant provider apps.** Each channel records the platform app it was
  authorized through. A client can bring its own Meta or Google app, and one
  restricted app does not take every client down.
- **Exactly-once where it matters.** Submitting the same post revision twice
  returns the existing jobs. A request that may have reached the platform with
  no confirmed result is marked `uncertain` and never retried automatically.
- **Pause, cancel, retries, reconciliation**, token renewal and a per-channel
  daily limit.
- **Browser runner** for platforms without a usable API: one persistent,
  logged-in Chromium profile per account, logins sealed to the runner's key
  (the engine stores them but cannot open them), and a person can take over at
  login checkpoints through noVNC.
- **AI answers (optional).** Each new direct message and comment can be
  sorted (answer automatically, draft for a person, or no answer needed) and
  drafted with Claude for the control plane to approve. The engine still
  sends only what was approved, and re-checks its own records before an
  automatic send ([ADR 0004](docs/adr/0004-engine-drafts-replies.md)).
- **Signed webhooks** ([Standard Webhooks](https://www.standardwebhooks.com/))
  for published and failed posts, moving numbers, new comments, new posts made
  elsewhere, profile edits, channel status, replies and messages; and signed
  events that tell the control plane when to pull.
- **PostgreSQL only.** The `jobs` table is the queue: no Redis, Temporal or
  separate broker. Channel tokens are encrypted at rest with a rotating keyring.

Posting through a website rather than an official API can conflict with a
platform's terms and get an account restricted. The browser runner is
optional; the engine runs without it, and you decide which accounts go
through it.

## Status

It runs in production for an agency's own channels and its clients' channels.
See [ROADMAP.md](ROADMAP.md) for what is next and
[ADR 0001](docs/adr/0001-own-engine-replaces-postiz.md) for why it exists.

## Getting started

Node 22 and pnpm. The database tests start a disposable PostgreSQL 17
container, so they need Docker (or set `SOCIAL_TEST_POSTGRES_URL`, see
[CONTRIBUTING.md](CONTRIBUTING.md)).

```sh
pnpm install
cp .env.example .env     # then fill in the values
pnpm verify              # lint, typecheck, unit tests, build
pnpm test:db             # PostgreSQL integration tests
pnpm db:migrate          # with DATABASE_MIGRATION_URL set
pnpm dev
```

[docs/deploy.md](docs/deploy.md) covers the database roles, provider apps,
the container images and the browser runner. [docs/api.md](docs/api.md) is the
API your control plane calls.

## Documentation

- [Domain context](CONTEXT.md): the words this project uses.
- [Engine API](docs/api.md).
- [Running it](docs/deploy.md).
- [Architecture decisions](docs/adr/).
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md).
- [Contributing](CONTRIBUTING.md): invariants, conventions and the checks to run before a pull request.

## Maintenance

Maintained for our own needs. Issues and pull requests are welcome (see
[CONTRIBUTING.md](CONTRIBUTING.md)); changes
that fit how we run it are the most likely to be merged, and there is no
support commitment. Report security problems privately, as
[SECURITY.txt](SECURITY.txt) describes.

## License and credit

[MIT](LICENSE). If you use this software, please credit
[Luciano Nery](https://lucianonery.dev): keep the copyright notice, and a link
back is appreciated.
