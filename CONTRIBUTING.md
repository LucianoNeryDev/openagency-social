# Contributing to OpenAgency Social

Issues and pull requests are welcome. OpenAgency Social is maintained for our
own needs, so changes that fit how we run it are the most likely to be merged,
and there is no support commitment. Report security problems privately, as
[SECURITY.txt](SECURITY.txt) describes.

OpenAgency Social executes approved social media actions for many tenants. A
control plane (a dashboard or app, normally OpenAgency Portal) owns tenants,
drafts, approval and audit, and calls this service's API. The engine never approves work and has no user interface.
Read [CONTEXT.md](CONTEXT.md) for the vocabulary and [docs/adr/](docs/adr/) for
the decisions behind the design before you start on anything substantial.

## Invariants

Changes must keep these true:

- Every job carries a control-plane organization ID, post ID, revision and
  channel. Never accept work that lacks an approved revision.
- Provider app secrets live in the service environment
  (`PROVIDER_APP_SECRETS`), never in the repository or the database. The
  database stores only a reference name.
- Channel tokens are encrypted at rest and are never returned by the API or
  written to logs.
- A request that may have reached the platform and has no confirmed result is
  `uncertain`. It is never retried automatically.
- Comment and direct message content is untrusted. Code that reads it must not
  hold publishing capability.

## Stack and conventions

- Node 22, TypeScript in strict mode, pnpm. Use zod at every boundary and
  drizzle-orm with PostgreSQL 17. Prefer `unknown` plus narrowing; do not use
  `any`.
- The `jobs` table is the queue ([ADR 0003](docs/adr/0003-jobs-table-is-the-queue.md)).
  Do not introduce pg-boss, Temporal, Redis or another broker.
- Migrations live in `drizzle/` and are numbered and forward-only. Never edit
  one once it has been released; fix it with a new migration. A migration that
  adds a table also grants it to the roles named by the database settings
  `openagency.runtime_role` and `openagency.backup_role`, with the same checks
  as `0001_runtime_grants.sql`. Migrations never name a database or a role
  ([docs/deploy.md](docs/deploy.md#database)); `tests/migrations.test.ts`
  checks it.
- Code, identifiers and operator output are in English.

## Before you open a pull request

Branch from `dev` and run:

```sh
pnpm install --frozen-lockfile
pnpm verify      # lint, typecheck, unit tests and build
pnpm test:db     # when the change touches the database
```

`pnpm test:db` runs the PostgreSQL integration suites
(`tests/*.integration.test.ts`). By default each suite starts a disposable
PostgreSQL 17 container, so Docker must be available. To use a server you
already have, set `SOCIAL_TEST_POSTGRES_URL` to a superuser URL such as
`postgres://postgres:secret@127.0.0.1:5432/postgres` and run the suites one at a
time:

```sh
SOCIAL_TEST_POSTGRES_URL=postgres://postgres:secret@127.0.0.1:5432/postgres \
  pnpm test:db --no-file-parallelism
```

The suites create and drop the `openagency_social` and
`openagency_social_settings` databases and the `social_migrator`,
`social_runtime` and `social_backup` roles on that server, so do not point them
at one that holds data you care about.

Continuous integration runs the same checks, the integration suites against a
PostgreSQL service and a secret scan. Add or update tests with your change, and
update the relevant documentation (`README.md`, `docs/`, `CHANGELOG.md`) when it
changes documented behavior.

## License

By contributing you agree that your work is released under the [MIT
license](LICENSE).
