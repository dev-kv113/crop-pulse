# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

Crop Analytics shows sugarcane farmers their plots on satellite imagery, coloured
by survey layers. FastAPI + PostgreSQL/PostGIS backend, React + MapLibre PWA
frontend, in one repository. [README.md](README.md) has the overview and
[docs/CODEBASE.md](docs/CODEBASE.md) explains the code file by file.

## Layout

| Path | What it is |
|---|---|
| `backend/app/` | FastAPI app. Routers in `routers/`, API contract in `models.py`, GeoJSON import in `ingest.py` |
| `backend/migrations/` | Numbered `.sql` files, applied at API startup and recorded in `schema_migrations` |
| `frontend/src/` | React app. Every backend call lives in `api.ts`; `types.ts` mirrors `backend/app/models.py` |
| `scripts/` | `start.sh` (local full stack), `deploy.sh` (production: `--setup` once, then every release, run on the server) |
| `deploy/` | host nginx template (`deploy.sh --setup` installs it), IAM policy for backups, secrets placeholder |
| `docker-compose.yml` | db + api + web. `docker-compose.prod.yml` is the production override (loopback-only ports) |

## Running it

```bash
scripts/start.sh                    # everything in Docker; web on :8080 (or the next free port)
# or, for frontend work with hot reload:
docker compose up -d db api         # API on :8010, Postgres on :5433
cd frontend && npm run dev          # web on :5174
```

Admin sign-in uses `ADMIN_PHONES` from `backend/.env`. With
`SMS_PROVIDER=console` the code is shown on screen and in `docker compose logs api`.

## Checking your work

There is no automated test suite. Before calling a change done:

- **Frontend:** `cd frontend && npm run typecheck` must pass. The production
  image build (`npm run build`) runs `tsc` too and fails on type errors.
- **Backend:** rebuild and restart (`docker compose up -d --build api`), check
  `curl localhost:8010/health`, then exercise the endpoints you changed through
  `http://localhost:8010/docs`.
- **Both:** if you changed an API shape, test it from the web app as well as from
  `/docs`.

## Conventions

- **Schema changes go in a new migration** (`backend/migrations/NNN_name.sql`, next
  number). Never edit a migration that has already shipped; it will not run again.
- **API shape changes touch both sides:** `backend/app/models.py` and
  `frontend/src/types.ts` change together.
- **Frontend network calls go through `frontend/src/api.ts`**, nowhere else.
- **Comments explain why**, often at length: the reason behind a port, a timeout,
  a cache header. Match that density; do not strip existing comments.
- **Shell scripts** use `set -euo pipefail` and live in `scripts/`.
  `frontend/scripts/` holds the frontend's own npm tooling (`npm run icons`,
  `npm run assetlinks`), which is separate.

## Safety

- **Never commit secrets.** `.env` files are git-ignored. `deploy/secrets/` is a
  placeholder inside the repo; real secrets live outside it, in `SECRETS_DIR`.
- **There is no CI.** Pushing deploys nothing, but the next `scripts/deploy.sh`
  ships whatever is on `main`, so keep `main` releasable.
- **Deploy only with `scripts/deploy.sh`.** It refuses unsafe settings (console
  OTPs, placeholder `JWT_SECRET`, default DB password, any container reachable
  from outside), backs up the database first, and rolls back a release that
  does not come up healthy.
- **Only the host's nginx faces the internet.** In production every container
  port is bound to `127.0.0.1`; keep it that way in `docker-compose.prod.yml`.
- **Cache headers live in `frontend/nginx.conf`.** `index.html`, `sw.js` and the
  manifest must stay `no-store`, or installed phones never receive an update.
- **Do not edit tracked files on a server.** `deploy.sh` refuses to pull over
  local changes. Server-specific settings go in the untracked root `.env`
  (`COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml`).

## Commits: Conventional Commits

Every commit message follows [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <summary>

<body: what changed and why, wrapped at 72>

<footers>
```

**Types**

| Type | Use for |
|---|---|
| `feat` | a new capability for users, admins or operators |
| `fix` | a bug fix |
| `docs` | documentation only |
| `refactor` | a code change that neither fixes a bug nor adds a feature |
| `perf` | a performance improvement |
| `test` | adding or fixing tests |
| `build` | Dockerfiles, dependencies, the Vite/TypeScript build |
| `chore` | anything else that does not touch app behaviour |
| `revert` | reverting an earlier commit |

**Scopes** (optional, but use one when it fits): `backend`, `frontend`, `db`
(migrations), `ingest`, `auth`, `admin`, `map`, `pwa`, `android`, `deploy`,
`scripts`, `docs`.

**Rules**

- Write the summary in the imperative mood ("add", not "added"), lower case,
  with no trailing period, and keep the whole first line under 72 characters.
- Make one logical change per commit. A feature and an unrelated fix are two
  commits.
- Mark a breaking change with `!` after the type/scope and a `BREAKING CHANGE:`
  footer saying what breaks and how to migrate. Breaking changes include an API
  contract change the installed app cannot handle, and a required new env var.

```
feat(ingest): accept survey layers in EPSG:32643
fix(auth): reject OTPs after the configured attempt limit
feat(backend)!: require UNIT_ID on plot import

BREAKING CHANGE: POST /api/admin/plots/import now needs a unit_id form
field. Older admin clients get a 422 until updated.
```
