# Migration Rollout

This document covers the operational procedure for deploying database migrations to production, including backup, rollback, and failure response.

---

## Pre-Deploy Backup

**Always** create a database backup before deploying:

```bash
bash deploy/backup-restore.sh backup
```

This creates a timestamped backup file that can be used for restoration if the deployment or migration fails. Note the backup filename — you will need it if a rollback is required.

Never skip this step, even for seemingly safe migrations.

---

## Compatibility Window

Migrations applied to a running production database must be **backward-compatible** with the currently deployed application code. This is critical because `deploy/deploy.sh` applies migrations *after* new containers are built and started — meaning the old API version may briefly serve requests against the new schema.

### Rules

- **No breaking column drops** in a single deploy. If a column must be removed, do it across multiple deploys:
  1. **Deploy 1**: Stop writing to the column (application change). Leave the column in the schema.
  2. **Deploy 2**: Drop the column (migration only, no application change needed).
- **No breaking type changes** in a single deploy. If a column type must change:
  1. **Deploy 1**: Add a new column with the desired type. Dual-write to both columns (application change).
  2. **Deploy 2**: Backfill the new column from the old one (data migration).
  3. **Deploy 3**: Switch reads to the new column (application change).
  4. **Deploy 4**: Drop the old column (migration only).
- **Additive changes are safe**: Adding a new table, new nullable column, or new index can be done in a single deploy without a multi-phase transition.
- **Adding NOT NULL constraints** is safe only if the column already has no NULL values in production. If NULLs exist, backfill first in a separate deploy.

### Summary

| Operation | Single deploy? | Multi-deploy? |
|---|---|---|
| Add table | Yes | — |
| Add nullable column | Yes | — |
| Add index | Yes | — |
| Drop column | No | 2 phases |
| Change column type | No | 4 phases |
| Add NOT NULL constraint | Only if no NULLs exist | Otherwise 2 phases |

---

## Rollout Steps

### a. SSH to the server

```bash
ssh production
```

### b. Backup the database

```bash
cd /srv/iquote
bash deploy/backup-restore.sh backup
```

Record the backup filename from the output.

### c. Pull code (handled by deploy.sh)

`deploy/deploy.sh` automatically fetches the latest code from the `main` branch:

```bash
git fetch origin main
git reset --hard origin/main
```

No manual pull is needed.

### d. Deploy

```bash
bash deploy/deploy.sh
```

This script performs the full deployment:
1. Pulls the latest code from `main`
2. Validates `.env.prod` configuration
3. Builds and starts Docker containers (`docker compose -f docker-compose.prod.yml up -d --build`)
4. Waits for API health check (up to 60 seconds)
5. Runs `prisma migrate deploy` inside the API container
6. Configures Nginx reverse proxy
7. Reports deployment summary with commit hash

### e. Verify migration output

Check the API logs for migration confirmation:

```bash
docker compose -f docker-compose.prod.yml logs api | grep -i migrat
```

You should see output like:

```
Applying migration `20261119000000_init`
Applying migration `20261119010000_tenant_consistency`
All migrations applied successfully.
```

If the migrations were already marked as applied (baseline procedure), you should see:

```
No pending migrations to apply.
```

### f. Health check

```bash
curl https://iquote.trendscore.co.ke/health
```

Expected response: `{"status":"ok"}` (or similar 200 OK response).

Also verify the version endpoint:

```bash
curl https://iquote.trendscore.co.ke/api/version
```

Confirm the commit hash matches the deployed commit.

---

## Rollback Procedure

### Scenario 1: Migration fails to apply

If `prisma migrate deploy` exits with a non-zero code, `deploy/deploy.sh` stops immediately (`set -euo pipefail`). The containers are already running the new code, but the database schema was not updated.

**Action:**

1. Check migration status:

   ```bash
   docker compose -f docker-compose.prod.yml exec -T api \
     npx prisma migrate status
   ```

2. Check the API logs for the specific error:

   ```bash
   docker compose -f docker-compose.prod.yml logs api
   ```

3. The old containers were replaced during `docker compose up -d --build`. If the new code is incompatible with the old schema, stop the API:

   ```bash
   docker compose -f docker-compose.prod.yml stop api
   ```

4. Fix the migration SQL, push new code, and redeploy:

   ```bash
   bash deploy/deploy.sh
   ```

### Scenario 2: Migration applied but application is broken

The migration succeeded but the new code has a runtime bug or the schema change broke application logic.

**Action:**

1. Stop the API container:

   ```bash
   docker compose -f docker-compose.prod.yml stop api
   ```

2. Restore the database from the pre-deploy backup:

   ```bash
   bash deploy/backup-restore.sh restore <pre-deploy-backup>
   ```

   Replace `<pre-deploy-backup>` with the backup filename from step (b) above.

3. Roll back the code to the previous commit:

   ```bash
   git checkout <previous-commit>
   docker compose -f docker-compose.prod.yml up -d --build
   ```

4. Verify health:

   ```bash
   curl https://iquote.trendscore.co.ke/health
   ```

### Scenario 3: Migration applied but needs reverting (no code rollback)

If the code is fine but the migration itself introduced a schema problem:

1. Stop the API:

   ```bash
   docker compose -f docker-compose.prod.yml stop api
   ```

2. Restore the database from the pre-deploy backup:

   ```bash
   bash deploy/backup-restore.sh restore <pre-deploy-backup>
   ```

3. Restart the API (same code version):

   ```bash
   docker compose -f docker-compose.prod.yml up -d api
   ```

There is **no automatic migration rollback** (Prisma does not generate down migrations). Database restoration from backup is the rollback mechanism for applied migrations.

---

## Failed Migration Response

### How deploy.sh handles migration failure

`deploy/deploy.sh` step 4 runs:

```bash
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T api npx prisma migrate deploy
```

With `set -euo pipefail`, any non-zero exit code from `prisma migrate deploy` causes the script to exit immediately. The deployment stops before reaching the Nginx configuration and summary steps.

### Diagnosing the failure

1. Check migration status:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T api \
     npx prisma migrate status
   ```

   This shows which migrations are applied, pending, or failed.

2. Check API logs:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod logs api
   ```

   Look for Prisma error messages indicating which migration failed and why (e.g., syntax error, constraint violation, existing object).

### Fixing and redeploying

1. Fix the migration SQL in the relevant `migration.sql` file.
2. Commit and push the fix to `main`.
3. Re-run the deployment:

   ```bash
   bash deploy/deploy.sh
   ```

   `prisma migrate deploy` will detect the failed migration state and re-attempt.

### Handling partially applied migrations

If a migration partially applied (e.g., some statements succeeded before an error), Prisma marks the migration as failed. The database is in an inconsistent state.

**Option A — Mark as rolled back and fix:**

If the partial changes are safe to leave in place (e.g., a table was created but an index was not):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T api \
  npx prisma migrate resolve --rolled-back <migration_name>
```

This marks the migration as not applied, allowing `migrate deploy` to re-attempt it. Ensure the migration SQL is idempotent or manually clean up the partial changes first.

**Option B — Restore from backup:**

If the partial changes are not safe to leave:

```bash
bash deploy/backup-restore.sh restore <pre-deploy-backup>
```

Then fix the migration, push new code, and redeploy.
