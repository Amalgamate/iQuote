# Migration Baseline

## Purpose

The iQuote project previously used `prisma db push` (schemaless sync) for all database changes. This approach had significant drawbacks in production:

- **No migration history**: `db push` does not record applied migrations, making it impossible to know which schema changes have been applied to a given database.
- **No drift detection**: Without migration records, there is no reliable way to determine whether the production database matches the checked-in `schema.prisma`.
- **No rollback path**: `db push` applies changes destructively and leaves no artifact for reverting.
- **No audit trail**: Schema changes were not version-controlled SQL files, so code review could not catch dangerous operations.

To solve these problems, the project has moved to **Prisma Migrate** (`prisma migrate deploy` in production, `prisma migrate dev` in local development). Two versioned migrations now exist in `api/prisma/migrations/`:

| Migration | Description |
|---|---|
| `20261119000000_init` | Full schema baseline — all tables, indexes, foreign keys, and the `QuoteStatus` enum as of commit `7d5d79e`. |
| `20261119010000_tenant_consistency` | Sets `Customer.organisationId` to `NOT NULL` and adds a cross-table trigger enforcing that `Quote.organisationId` matches `Customer.organisationId`. |

The production deploy script (`deploy/deploy.sh`) now runs `prisma migrate deploy` instead of `db push`.

---

## Baseline Procedure

### For existing production databases

The production database was created via `db push` and already contains all tables. The two migrations above describe schema changes that are **already present** in the database. Running `prisma migrate deploy` would attempt to re-apply them and fail. Instead, we mark them as already applied using `prisma migrate resolve --applied`.

**Steps:**

1. **Back up the production database first.** See [MIGRATION_ROLLOUT.md](./MIGRATION_ROLLOUT.md) for the backup procedure.

2. **Mark the init migration as applied:**

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T api \
     npx prisma migrate resolve --applied 20261119000000_init
   ```

3. **Mark the tenant consistency migration as applied:**

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T api \
     npx prisma migrate resolve --applied 20261119010000_tenant_consistency
   ```

4. **Verify migration status:**

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T api \
     npx prisma migrate status
   ```

   You should see both migrations listed as applied with no pending migrations.

### For fresh databases

No baseline marking is needed. Running `prisma migrate deploy` will apply all migrations from scratch:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T api \
  npx prisma migrate deploy
```

This is what `deploy/deploy.sh` does automatically during deployment.

---

## Reconciliation Procedure

After marking the baseline migrations as applied, the production database may still have **schema drift** — differences between what `db push` created and what `schema.prisma` describes (e.g., missing indexes, slightly different column types, or orphaned tables).

### Detecting drift

Compare the database state against the schema:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T api \
  npx prisma migrate diff \
    --from-schema-datasource api/prisma/schema.prisma \
    --to-schema-datamodel api/prisma/schema.prisma \
    --shadow-database-url "$SHADOW_DATABASE_URL"
```

Alternatively, to diff the database against the migration history:

```bash
npx prisma migrate diff \
  --from-migrations api/prisma/migrations \
  --to-schema-datasource api/prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL"
```

### Resolving drift

If `migrate diff` reports differences:

1. **Create a new migration** to reconcile the database with the schema. Do this locally:

   ```bash
   cd api
   npx prisma migrate dev --name reconcile_drift
   ```

2. **Review the generated SQL** in `api/prisma/migrations/<timestamp>_reconcile_drift/migration.sql` carefully. Ensure no destructive operations (e.g., `DROP TABLE`, `ALTER COLUMN TYPE`) are present unless intentionally fixing drift.

3. **Commit the migration** and deploy via the normal rollout procedure.

4. **Never use `db push` in production.** It bypasses migration history and can silently introduce drift.

---

## Pre-Rehearsal

Before running the baseline procedure on production, test it against a non-production copy of the database.

### 1. Clone the production database

On the production server (or a machine with access to the database):

```bash
# Dump the production database
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > /tmp/iquote_prod_dump.sql

# Create a test database and load the dump
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE iquote_test;"

docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d iquote_test < /tmp/iquote_prod_dump.sql
```

### 2. Run the baseline procedure on the test database

Point `DATABASE_URL` at the test database and run:

```bash
DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/iquote_test" \
  npx prisma migrate resolve --applied 20261119000000_init

DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/iquote_test" \
  npx prisma migrate resolve --applied 20261119010000_tenant_consistency
```

### 3. Verify migration status

```bash
DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/iquote_test" \
  npx prisma migrate status
```

Both migrations should show as applied with no pending migrations.

### 4. Check for drift

```bash
DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/iquote_test" \
  npx prisma migrate diff \
    --from-schema-datasource api/prisma/schema.prisma \
    --to-schema-datamodel api/prisma/schema.prisma
```

If the diff is empty, the production database is in sync. If differences are reported, follow the [Reconciliation Procedure](#resolving-drift) before deploying.

### 5. Clean up

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE iquote_test;"
rm /tmp/iquote_prod_dump.sql
```

---

## Local Development

During local development, use `prisma migrate dev` to create and apply migrations:

```bash
cd api
npx prisma migrate dev --name <descriptive_name>
```

This command:

1. Applies any pending migrations to the local database.
2. Detects schema changes and generates a new migration SQL file.
3. Applies the new migration to the local database.
4. Regenerates the Prisma Client.

**Guidelines:**

- Always review the generated SQL in `api/prisma/migrations/<timestamp>_<name>/migration.sql` before committing.
- Never use `db push` — it creates no migration artifact and breaks the migration history.
- If `migrate dev` detects drift (schema changes not captured by a migration), it will prompt to reset the database. In local development this is fine; in production it is not.
- Commit migration files to the repository so they are included in the next deploy.
