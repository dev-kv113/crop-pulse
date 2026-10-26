Placeholder so `docker compose up` has something to mount when SECRETS_DIR is
not set. **Do not put real secrets here** — this directory is inside the
repository.

Real secrets go in a directory outside the repo, pointed at by SECRETS_DIR in
the `.env` file next to docker-compose.yml. See docs/DEPLOY.md.
