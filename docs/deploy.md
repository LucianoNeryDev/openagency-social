# Running it

The engine is one Node process (HTTP API and worker) with its own PostgreSQL
17 database. The browser runner is a second, optional container for
platforms driven through a website.

## Database

Create the database and its roles yourself, then name the roles to the
migrations with three database settings. The migrations grant every table to
the roles these settings name, and name no database or role themselves, so any
names work. The suite's own installs use these:

| Database | Migrator role | Runtime role | Backup role |
| --- | --- | --- | --- |
| `openagency_social` (local) | `social_migrator` | `social_runtime` | — |
| `openagency_social_<env>` | `social_migrator_<env>` | `social_runtime_<env>` | `social_backup_<env>` |

As a superuser, once per database and before the first migration:

```sql
CREATE ROLE social_migrator LOGIN PASSWORD '…';
CREATE ROLE social_runtime LOGIN PASSWORD '…' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE openagency_social OWNER social_migrator;
REVOKE ALL ON DATABASE openagency_social FROM PUBLIC;
GRANT CONNECT ON DATABASE openagency_social TO social_migrator, social_runtime;
ALTER DATABASE openagency_social SET openagency.migrator_role = 'social_migrator';
ALTER DATABASE openagency_social SET openagency.runtime_role = 'social_runtime';
-- Optional: a read-only role for backups, created like the runtime role.
ALTER DATABASE openagency_social SET openagency.backup_role = 'social_backup';
```

| Setting | Meaning |
| --- | --- |
| `openagency.migrator_role` | The role `pnpm db:migrate` connects as; the migrations refuse to run as any other |
| `openagency.runtime_role` | The role `DATABASE_URL` connects as: read and write on every table, append-only on `events` |
| `openagency.backup_role` | Optional: read-only on every table and sequence |

A migration fails with the setting's name when a required setting is unset,
when a role it names does not exist, or when the runtime role is the migrator,
a superuser or otherwise elevated. Settings reach new sessions only, so set
them before migrating. The migrator role owns the database and is used only by
`pnpm db:migrate` (`node dist/cli/migrate.js` in the container) with
`DATABASE_MIGRATION_URL`.

## Engine

```sh
docker build --build-arg VCS_REF=$(git rev-parse HEAD) -t openagency-social .
```

Configuration comes from the environment; [.env.example](../.env.example)
lists every variable. The engine binds to loopback only, so run your control
plane's API on the same host (or in the same network namespace) and call it at
`http://127.0.0.1:<port>`. `/healthz` and `/readyz` report liveness and
database readiness; `/readyz` also reports whether publishing keeps up
(`publishing`, [api.md](api.md#jobs)).

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Runtime role |
| `SERVICE_TOKEN` | At least 32 characters, shared with the control plane |
| `TOKEN_KEYS`, `TOKEN_KEY_ACTIVE` | Channel token encryption keyring; keep retired keys to read old tokens |
| `PROVIDER_APP_SECRETS` | `{"<secret reference>": "<app secret>"}` |
| `META_REDIRECT_URI` | The control plane's Meta OAuth callback |
| `GOOGLE_REDIRECT_URI`, `INSTAGRAM_REDIRECT_URI` | Optional OAuth callbacks; without them those channels can only be imported |
| `PUBLIC_MEDIA_URL` | The control plane's signed media route ([docs/api.md](api.md)); Instagram and the runner fetch media from it |
| `RUNNER_URL`, `RUNNER_TOKEN` | Optional browser runner |
| `ANTHROPIC_API_KEY`, `LIQUID_API_KEY` | Optional AI answers: drafting (Anthropic) and the decision (Liquid AI); redacted from logs |
| `CONTROL_PLANE_EVENTS_URL` | Optional: the control plane's events route, `https:` or `http:` on loopback ([docs/api.md](api.md)) |
| `WORKER_CONCURRENCY`, `WORKER_VIDEO_SLOTS`, `WORKER_BROWSER_SLOTS` | Optional, defaults 2, 1, 1: jobs at once for standard posts, video posts and browser jobs. Each lane has its own slots, so a few reels or a browser session cannot hold other posts past the one-hour lateness limit |
| `SHUTDOWN_GRACE_MS` | Optional, default 25000: how long a stopping engine lets publishes finish (below) |

### Stopping and deploying

On `SIGTERM` the engine stops claiming jobs and gives publishes in flight
`SHUTDOWN_GRACE_MS` (default 25 s) to finish. Half way, every attempt that has
not yet sent its visible request (see `sentAt` in [api.md](api.md#jobs)) is
closed and its job queued again; the next engine starts it at once. Attempts
that did send get the rest of the grace. One still open when the grace ends is
left to the next engine's sweeper, which makes it `uncertain` after ten
minutes, and reconcile or a person settles it.

Give the orchestrator a stop timeout longer than the grace, or it kills the
process mid-request. Nomad's default `kill_timeout` is 5 s and a client caps
it at `max_kill_timeout` (30 s by default): with the defaults, set
`kill_timeout = "30s"` and keep `SHUTDOWN_GRACE_MS` at 25 s. With a client
whose `max_kill_timeout` allows it, `SHUTDOWN_GRACE_MS=300000` and
`kill_timeout = "330s"` let a slow upload's last chunk finish. Only one
engine may run per database, so stop the old one before starting the new
(one allocation, no canaries).

## Provider apps

Each channel is authorized through a provider app registered once per
database. The secret itself stays in `PROVIDER_APP_SECRETS`; the database
holds only its reference:

```sh
pnpm provider-app --id meta-agency --platform meta --external-app-id <app id> --secret-ref meta-agency
```

`--mode live` records an app that is live on the platform (the default is
`development`). An app is shared by the agency or owned by one tenant
(`--owner tenant --owner-organization <id>`), as [ADR 0002](adr/0002-per-tenant-provider-apps.md)
describes. In the container the same commands are
`node dist/cli/provider-app.js` and `node dist/cli/channel.js`.

## WhatsApp

WhatsApp numbers connect through a provider app of platform `whatsapp`. It
may be the same Meta app as the `meta` one, registered again with its own
Login for Business configuration, and the same secret reference:

```sh
pnpm provider-app --id meta-agency-whatsapp --platform whatsapp --external-app-id <app id> \
  --secret-ref meta-agency --config-id <WhatsApp configuration id>
```

On Meta's side: add the WhatsApp product to the app; create a Login for
Business configuration with the `whatsapp_business_management` and
`whatsapp_business_messaging` permissions whose token type is **user access
token** (a configuration issuing a system-user token offers no WhatsApp
account to pick, and the connect fails with `no_whatsapp_account`; the user
token lasts about 60 days, then the number is connected again); subscribe the app's webhook (the dashboard's
Meta receiver, the same callback URL and verify token as Messenger) to the
`whatsapp_business_account` object's `messages` field; and get Advanced
Access to both permissions (Business Verification and App Review) before
numbers of other businesses connect. The engine needs nothing new: the
callback is `META_REDIRECT_URI`, and the receiver checks the signature with
the app secret the dashboard holds, which must be this app's.

An operator can also connect one number with a system user's token, which
does not expire (`POST /v1/tenants/:org/whatsapp/numbers`, see
[api.md](api.md#whatsapp)). A connect fails with `no_whatsapp_account`,
`no_whatsapp_number` or `whatsapp_subscription_failed` (with Meta's code in
`detail`) rather than leave a number that would receive nothing.

## Comment replies

Replies need a permission on each provider's side, and channels must connect
again to grant it. Every connect asks for the reply permissions:
`youtube.force-ssl` on Google, and `pages_manage_engagement` on Meta without a
Login for Business configuration. A provider that has not granted them yet
refuses the connect, or shows a warning. Update each provider first, or pin
the provider app's scopes and unpin them once the provider allows the
permission:

```sh
node dist/cli/provider-app.js scopes --id youtube-agency                    # what it asks for now
node dist/cli/provider-app.js scopes --id youtube-agency --without-replies  # pin the defaults without the reply-only scopes
node dist/cli/provider-app.js scopes --id youtube-agency --default          # unpin, once the consent screen has it
```

`--set a,b` pins an explicit list (Google scopes by their last part, such as
`youtube.upload`). What each provider needs:

- Meta app, Login for Business configuration: `pages_manage_engagement`
  (Facebook replies) and `instagram_manage_comments` (Instagram replies and
  comment reads), and `ads_read` when an Instagram account's Page role comes
  from Business Manager.
- Google project (YouTube): `youtube.force-ssl` beside `youtube.upload` and
  `youtube.readonly` on the OAuth consent screen. It is a sensitive scope, so
  an app in production shows the unverified-app warning until Google verifies
  it.
- Instagram login: `instagram_business_manage_comments`, which must be
  approved on the app.

## Importing channels

`channel import` stores a grant obtained outside the engine, such as another
publisher's OAuth tokens for the same provider app, as a connected channel:

```sh
node dist/cli/channel.js import --org <organization> --provider-app <id> \
  --kind youtube_channel --external-id <channel id> --name <name> < credential.json
node dist/cli/channel.js list --org <organization>
```

`credential.json` is `{"accessToken", "refreshToken"?, "expiresAt"?}` on
stdin; it is encrypted with the active token key and never printed. The
provider app must be able to hold that kind of channel and serve that tenant.

## Browser runner

```sh
docker build -f deploy/runner/Dockerfile --build-arg VCS_REF=$(git rev-parse HEAD) -t openagency-social-runner .
pnpm vault keygen --out runner-key.json   # new key pair, written mode 600
```

The runner runs headed Chromium on a virtual display, with VNC and noVNC on
loopback for a person to take over at login checkpoints (CAPTCHA, device
checks).

| Variable | Value |
| --- | --- |
| `RUNNER_HOST`, `RUNNER_PORT` | Listen address, default `127.0.0.1:3430`; expose it only to the engine's host |
| `RUNNER_TOKEN` | At least 32 characters; the engine's `RUNNER_TOKEN` |
| `RUNNER_PRIVATE_KEY` | From `vault keygen`; opens the sealed logins |
| `RUNNER_VNC_PASSWORD` | Required; VNC on loopback `RUNNER_VNC_PORT` (5930), noVNC on `RUNNER_NOVNC_PORT` (6080) |
| `RUNNER_DATA_DIR` | Persistent volume for browser profiles and `actions.json`; default `/var/lib/openagency-social-runner` |
| `RUNNER_NTFY_URL` | Optional ntfy topic told when an account needs a person |
| `RUNNER_DISPLAY` | X display, default `:47`; with host networking it must not collide with a host display |

Reach noVNC through an SSH forward (`ssh -L 6080:127.0.0.1:6080 <host>`, then
`http://127.0.0.1:6080/vnc.html`). Release the runner before the engine when
the action request changes: the runner rejects fields it does not know.

Logins are sealed to the runner's public key and stored by the engine, which
cannot open them:

```sh
RUNNER_PUBLIC_KEY=… pnpm vault put --org <organization> --platform tiktok --handle <handle> < login.json
pnpm vault link --org <organization> --account <account id> [--page <company id>] [--name <name>]
```

`login.json` is `{"username", "password", "totp"?}`. The login itself starts
from the API ([docs/api.md](api.md), browser accounts).
