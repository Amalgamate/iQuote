# iQuote — Release Checklist

Practical operational checklist for production releases. Work through each section in order.

**Production URL:** https://iquote.trendscore.co.ke
**Server:** 185.127.16.124 (SSH alias: `production`)
**Repo on server:** `/srv/iquote`

---

## Pre-Deploy Checklist

- [ ] Code reviewed and merged to `main`
- [ ] CI pipeline passed (type checks, tests, build)
- [ ] Database backup taken: `bash deploy/backup-restore.sh backup`
- [ ] `.env.prod` reviewed for any new required variables
  - Required vars: `POSTGRES_PASSWORD`, `JWT_SECRET`, `PLATFORM_URL`, `TRUSTED_ORIGINS`
  - Compare against `.env.prod.example` for newly added variables
- [ ] Prisma migrations reviewed (if schema changes)
  - Check `prisma/migrations/` for new migration directories
  - Review up and down SQL in `migration.sql` files
- [ ] Migration backward compatibility verified
  - New columns should be nullable or have defaults
  - Renamed/removed columns require a multi-deploy strategy
  - Test migrations against a copy of production data if possible
- [ ] Deploy window confirmed (avoid business hours — ideally evenings/weekends)
- [ ] Notify stakeholders of planned deploy window

---

## Deploy Steps

1. **SSH to server:**
   ```bash
   ssh production
   ```

2. **Navigate to repo:**
   ```bash
   cd /srv/iquote
   ```

3. **Run deploy script:**
   ```bash
   bash deploy/deploy.sh
   ```
   The script performs these steps automatically:
   1. Pulls latest code from `main` (`git fetch` + `git reset --hard origin/main`)
   2. Validates `.env.prod` — checks required vars are set and not placeholders
   3. Builds and starts Docker containers (`docker compose up -d --build`)
   4. Waits for API health check (up to 60s, polls `http://127.0.0.1:5180/health`)
   5. Runs Prisma migrations (`npx prisma migrate deploy` — applies pending migrations only)
   6. Enables Nginx reverse proxy site and reloads
   7. Prints deployment summary with commit hash

4. **Monitor the output for errors** — the script uses `set -euo pipefail` and will exit non-zero on any failure.

5. **If `deploy.sh` exits non-zero:** DO NOT proceed to post-deploy verification. Investigate the error output and follow the [Rollback Procedure](#rollback-procedure) if needed.

> **Note:** The deploy script prints the deployed commit hash and build time at the end. Note these down for reference.

---

## Post-Deploy Verification

Run through every item. If any check fails, investigate before proceeding — consider rollback.

### Health & Version

- [ ] **Health check:**
  ```bash
  curl -s https://iquote.trendscore.co.ke/health
  ```
  Expected: `{"status":"ok","database":"connected"}`

- [ ] **Version check:**
  ```bash
  curl -s https://iquote.trendscore.co.ke/api/version
  ```
  Verify the `commit` field matches the expected git commit hash.
  Also verify `buildTime` is recent.

### SSL

- [ ] **Certificate validity:**
  ```bash
  echo | openssl s_client -connect iquote.trendscore.co.ke:443 2>/dev/null | openssl x509 -noout -dates
  ```
  Verify `notAfter` is in the future (Certbot auto-renews, but confirm).

### Functional Smoke Test

- [ ] Login with a test account
- [ ] Create a new quote
- [ ] View a public quote link
- [ ] Verify quote list loads

### Logs & Errors

- [ ] **Check recent API logs:**
  ```bash
  docker compose -f docker-compose.prod.yml logs --tail=50 api
  ```
  Look for error-level entries, stack traces, or unhandled rejections.

- [ ] **No error spikes** — no unusual volume of errors compared to baseline.

### Security Headers

- [ ] **Nginx security headers present:**
  ```bash
  curl -sI https://iquote.trendscore.co.ke | grep -i 'x-content-type\|x-frame\|referrer'
  ```
  Expected headers:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY` or `SAMEORIGIN`
  - `Referrer-Policy: strict-origin-when-cross-origin`

---

## Rollback Procedure

Use this if the deploy fails or causes issues in production.

1. **Stop the API container:**
   ```bash
   cd /srv/iquote
   docker compose -f docker-compose.prod.yml stop api
   ```

2. **Restore the database from pre-deploy backup:**
   ```bash
   bash deploy/backup-restore.sh restore <pre-deploy-backup-file>
   ```
   Replace `<pre-deploy-backup-file>` with the backup filename from the pre-deploy step.
   Backups are stored in `/srv/iquote-backups/`.

3. **Roll back code to the previous known-good commit:**
   ```bash
   git checkout <previous-good-commit>
   ```
   Use the commit hash from the last successful deploy (check `/api/version` output or git log).

4. **Rebuild and restart containers:**
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
   ```

5. **Verify health check passes:**
   ```bash
   curl -s https://iquote.trendscore.co.ke/health
   ```
   Must return `{"status":"ok","database":"connected"}`.

6. **Document the rollback:**
   - Record the reason for rollback
   - Note the failed commit hash
   - Note the restored commit hash
   - Create an issue to track the fix

---

## Deployed Commit Identification

Multiple methods to verify what version is currently running in production:

| Method | Command |
|--------|---------|
| **API version endpoint** | `curl -s https://iquote.trendscore.co.ke/api/version` |
| **Deploy script output** | The script prints the commit hash at the end of deployment |
| **Container label** | `docker inspect iquote-api \| grep GIT_COMMIT` |
| **Git on server** | `cd /srv/iquote && git rev-parse --short HEAD` |

The `/api/version` endpoint returns:
```json
{
  "version": "1.x.x",
  "commit": "abc1234",
  "buildTime": "2026-01-15T10:30:00Z",
  "node": "v20.x.x"
}
```

The Docker image is built with `GIT_COMMIT` and `BUILD_TIME` build args (set by `deploy.sh` from `git rev-parse` and `date`).

---

## Emergency Contacts & Resources

| Resource | Details |
|----------|---------|
| **Server access** | SSH alias `production` → `185.127.16.124` |
| **DNS management** | Cloudoon panel |
| **SSL certificates** | Certbot (auto-renews via `certbot.timer` systemd timer) |
| **SSL provisioning** | `sudo bash deploy/provision-ssl.sh` |
| **Backups** | `/srv/iquote-backups/` |
| **Backup/restore** | `bash deploy/backup-restore.sh backup` / `restore <file>` |
| **Superadmin promotion** | `docker compose -f docker-compose.prod.yml exec -T api node scripts/promote-superadmin.mjs <email>` |
| **Container logs** | `docker compose -f docker-compose.prod.yml logs --tail=50 api` |
| **Container status** | `docker compose -f docker-compose.prod.yml ps` |
| **Nginx config** | `/etc/nginx/sites-available/iquote.trendscore.co.ke` |
| **Nginx reload** | `sudo nginx -t && sudo systemctl reload nginx` |

---

## Quick Reference: One-Liners

```bash
# Full health + version check
curl -s https://iquote.trendscore.co.ke/health && echo "" && curl -s https://iquote.trendscore.co.ke/api/version | jq

# Tail API logs
docker compose -f docker-compose.prod.yml logs -f --tail=50 api

# Check container status
docker compose -f docker-compose.prod.yml ps

# Check SSL cert expiry
echo | openssl s_client -connect iquote.trendscore.co.ke:443 2>/dev/null | openssl x509 -noout -dates

# Take a manual backup
bash deploy/backup-restore.sh backup
```
