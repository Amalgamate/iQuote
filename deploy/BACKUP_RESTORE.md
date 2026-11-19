# iQuote — Backup & Restore Guide

This document describes the backup and restore procedures for the iQuote production deployment.

## Overview

The backup system protects two data stores:

| Component          | Docker Volume     | Contents                                    |
| ------------------ | ------------------ | ------------------------------------------- |
| PostgreSQL database| `iquote_pgdata`    | All application data (quotes, users, tenants, settings) |
| Uploaded media     | `iquote_uploads`   | Logos, header images, and other uploaded files |

Both are bundled into a single `tar.gz` archive stored at `/srv/iquote-backups/`.

Each backup produces two files:

- `iquote-backup-YYYYMMDD-HHMMSS.tar.gz` — the archive
- `iquote-backup-YYYYMMDD-HHMMSS.meta` — metadata (timestamp, size, SHA-256 checksum)

## Backup Schedule

A daily backup runs automatically via cron at **2:00 AM server time**.

### Crontab Entry

```bash
0 2 * * * cd /srv/iquote && bash deploy/backup-restore.sh backup >> /var/log/iquote-backup.log 2>&1
```

To install the cron job:

```bash
sudo crontab -e
# Add the line above, save and exit
```

## Manual Backup

To create a backup on demand:

```bash
cd /srv/iquote
bash deploy/backup-restore.sh backup
```

Output will show the archive path, size, and checksum. The backup log is written to `/var/log/iquote-backup.log`.

## Restore Procedure

### Prerequisites

- SSH access to the production server (`ssh production`)
- The backup archive path (find with `bash deploy/backup-restore.sh list`)
- Estimated downtime: up to 1 hour (RTO)

### Step-by-Step Restore

1. **SSH into the production server:**

   ```bash
   ssh production
   ```

2. **Navigate to the project directory:**

   ```bash
   cd /srv/iquote
   ```

3. **List available backups:**

   ```bash
   bash deploy/backup-restore.sh list
   ```

4. **Run the restore command with the backup archive:**

   ```bash
   bash deploy/backup-restore.sh restore /srv/iquote-backups/iquote-backup-YYYYMMDD-HHMMSS.tar.gz
   ```

   The script will:
   - Verify the archive checksum (if `.meta` file exists)
   - Stop the API and Web containers (database stays running)
   - Drop and recreate the PostgreSQL database
   - Restore the database from the `pg_dump` archive
   - Restore the uploads volume contents
   - Restart all containers
   - Wait for the API health check to pass

5. **Verify the application is healthy:**

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod exec api wget -qO- http://localhost:4000/health
   ```

6. **Verify in the browser:** Navigate to the platform URL and confirm data is visible.

### Important Notes

- The restore process **drops and recreates** the database. Any data created after the backup will be lost.
- API and Web containers are stopped during restore. The database container stays running.
- The script waits up to 150 seconds (30 attempts × 5s) for the API health check after restart.

## Retention Policy

| Category | Retention | Description |
| -------- | --------- | ----------- |
| Daily    | 7 days    | All backups from the last 7 days are kept |
| Weekly   | 4 weeks   | Sunday backups kept for 28 days |
| Monthly  | 3 months  | Sunday backups kept for 90 days |

Backups older than 90 days are permanently deleted.

### Pruning

To manually prune old backups:

```bash
cd /srv/iquote
bash deploy/backup-restore.sh prune
```

Add to cron for automatic pruning (weekly, Sunday at 3 AM):

```bash
0 3 * * 0 cd /srv/iquote && bash deploy/backup-restore.sh prune >> /var/log/iquote-backup.log 2>&1
```

## Recovery Objectives

| Metric | Value | Description |
| ------ | ----- | ----------- |
| **RPO** (Recovery Point Objective) | 24 hours | Maximum acceptable data loss. With daily backups at 2 AM, you may lose up to 24 hours of data. |
| **RTO** (Recovery Time Objective) | 1 hour | Maximum acceptable downtime. A full restore (download, extract, restore DB, restore uploads, restart) should complete within 1 hour. |

## Restore Rehearsal (Non-Production)

It is recommended to test restore procedures in a non-production environment regularly (e.g., monthly).

### Procedure

1. **Copy a backup archive to a staging/test server:**

   ```bash
   scp production:/srv/iquote-backups/iquote-backup-YYYYMMDD-HHMMSS.tar.gz /tmp/
   ```

2. **On the test server, ensure Docker Compose is running:**

   ```bash
   cd /path/to/iquote
   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
   ```

3. **Run the restore:**

   ```bash
   bash deploy/backup-restore.sh restore /tmp/iquote-backup-YYYYMMDD-HHMMSS.tar.gz
   ```

4. **Verify the restored data:**
   - Check the API health endpoint: `curl http://localhost:4000/health`
   - Log in with a known account and verify data integrity
   - Check uploaded images are accessible

5. **Document the result:** Record the restore time, any errors encountered, and whether the RTO was met.

## Monitoring Backup Health

### Check Backup Exists and Is Recent

```bash
# Check that a backup was created within the last 25 hours
LATEST=$(ls -t /srv/iquote-backups/*.tar.gz 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
    echo "ALERT: No backups found!"
    exit 1
fi

AGE_HOURS=$(( ( $(date +%s) - $(date -r "$LATEST" +%s) ) / 3600 ))
if [ $AGE_HOURS -gt 25 ]; then
    echo "ALERT: Latest backup is ${AGE_HOURS}h old (threshold: 25h)"
    exit 1
fi

echo "OK: Latest backup is ${AGE_HOURS}h old"
```

### Check Backup Size

```bash
# Ensure backup is larger than a minimum threshold (e.g., 1 MB)
LATEST=$(ls -t /srv/iquote-backups/*.tar.gz 2>/dev/null | head -1)
SIZE_BYTES=$(stat -c%s "$LATEST")
SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))

if [ $SIZE_MB -lt 1 ]; then
    echo "ALERT: Backup is only ${SIZE_MB} MB — possible empty backup"
    exit 1
fi

echo "OK: Backup size is ${SIZE_MB} MB"
```

### Verify Checksum Integrity

```bash
# Verify the checksum of the latest backup
LATEST=$(ls -t /srv/iquote-backups/*.tar.gz 2>/dev/null | head -1)
META="${LATEST%.tar.gz}.meta"

if [ -f "$META" ]; then
    EXPECTED=$(grep '^checksum=' "$META" | cut -d= -f2)
    ACTUAL=$(sha256sum "$LATEST" | awk '{print $1}')
    if [ "$EXPECTED" = "$ACTUAL" ]; then
        echo "OK: Checksum verified"
    else
        echo "ALERT: Checksum mismatch!"
        exit 1
    fi
else
    echo "WARN: No metadata file for checksum verification"
fi
```

### Monitoring Script (Cron)

Create a monitoring check that runs every hour and alerts if backups are stale:

```bash
# /srv/iquote/deploy/check-backup-health.sh
#!/usr/bin/env bash
set -euo pipefail

LATEST=$(ls -t /srv/iquote-backups/*.tar.gz 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
    echo "CRITICAL: No iQuote backups found" >&2
    exit 2
fi

AGE_HOURS=$(( ( $(date +%s) - $(date -r "$LATEST" +%s) ) / 3600 ))

if [ $AGE_HOURS -gt 25 ]; then
    echo "CRITICAL: Latest backup is ${AGE_HOURS}h old" >&2
    exit 2
fi

SIZE_MB=$(( $(stat -c%s "$LATEST") / 1024 / 1024 ))
if [ $SIZE_MB -lt 1 ]; then
    echo "CRITICAL: Backup is only ${SIZE_MB} MB" >&2
    exit 2
fi

echo "OK: Backup healthy (${AGE_HOURS}h old, ${SIZE_MB} MB)"
```

```bash
# Crontab — check every hour
0 * * * * /srv/iquote/deploy/check-backup-health.sh >> /var/log/iquote-backup-monitor.log 2>&1
```
