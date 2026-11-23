# Running it

The engine is one Node process (HTTP API and worker) with its own PostgreSQL
17 database. The browser runner is a second, optional container for
platforms driven through a website.

## Database

The migrations grant tables to roles that are paired with the database name,
so use one of these combinations (later migrations grant their new tables to
the roles that already hold the earlier ones):

| Database | Runtime role | Backup role |
| --- | --- | --- |
| `leonessa_social_engine` | `social_engine_runtime` | — |
| `leonessa_social_engine_staging` | `social_engine_runtime_staging` | `social_engine_backup_staging` |
| `leonessa_social_engine_production` | `social_engine_runtime_production` | `social_engine_backup_production` |

Create the roles yourself. A separate migrator role owns the database and is
used only by `pnpm db:migrate` (`node dist/cli/migrate.js` in the container)
with `DATABASE_MIGRATION_URL`. The runtime role must not be a superuser or
owner: the first migration refuses an elevated runtime role.

## Engine

```sh
docker build --build-arg VCS_REF=$(git rev-parse HEAD) -t openagency-social .
```

Configuration comes from the environment; [.env.example](../.env.example)
lists every variable. The engine binds to loopback only, so run your control
plane's API on the same host (or in the same network namespace) and call it at
`http://127.0.0.1:<port>`. `/healthz` and `/readyz` report liveness and
database readiness.

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
| `RUNNER_DATA_DIR` | Persistent volume for browser profiles and `actions.json`; default `/var/lib/openagency-social-runner`. While unset, a runner whose old default `/var/lib/leonessa-browser-runner` exists and the new one does not keeps using the old directory (logged once at start); that fallback is dropped in wave 3c |
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

### Re-sealing logins after the vault label rename

The key that seals a login is derived with HKDF-SHA256 under the info label
`openagency-social-vault v1:<account>`. Logins stored before that were sealed
under `leonessa-vault v1:<account>`. The label is not stored with a login, so
the runner tries the current label first and then the old one, and the GCM
tag decides; nothing else about the stored login changes. `vault reseal` moves
stored logins onto the current label:

```sh
RUNNER_PRIVATE_KEY=… node dist/cli/vault.js reseal --dry-run   # counts only
RUNNER_PRIVATE_KEY=… node dist/cli/vault.js reseal             # re-seal, 50 rows per transaction
```

- Order: release the runner first (an older runner cannot open logins sealed
  under the new label, including new ones from `vault put`), then the engine.
  Run `reseal` once this version is settled in that environment, on staging
  first and production after; after it, rolling the runner back to an older
  version breaks every browser login.
- It needs the runner's private key and `DATABASE_URL` (the runtime role is
  enough). Pass the key for this one command only; it never belongs in the
  engine's environment. The command prints counts and account IDs, never
  logins.
- It locks each batch while re-sealing it, keeps each login's plaintext,
  status and `updated_at`, and records `browser_account.resealed` per account.
  Running it again changes nothing.
- A login that opens under neither label (sealed to another runner key, or
  damaged) is reported as unopenable, left as it is, and makes the command
  exit 1. Store it again with `vault put`.
