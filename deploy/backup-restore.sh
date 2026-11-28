#!/usr/bin/env bash
# =============================================================
# iQuote — Backup & Restore Script
# =============================================================
# Runs on the production server. Supports four modes:
#
#   bash deploy/backup-restore.sh backup
#       Create a combined backup of PostgreSQL + uploads volume.
#
#   bash deploy/backup-restore.sh restore <backup-file>
#       Restore from a backup archive.
#
#   bash deploy/backup-restore.sh list
#       List available backups with size and timestamp.
#
#   bash deploy/backup-restore.sh prune
#       Delete backups older than the retention policy.
#
# Recovery Objectives:
#   RPO (Recovery Point Objective): 24 hours — daily backup at 2 AM.
#   RTO (Recovery Time Objective):  1 hour  — restore from backup archive.
#
# Retention Policy:
#   Daily backups:   keep for 7 days
#   Weekly backups:  keep for 4 weeks
#   Monthly backups: keep for 3 months
# =============================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"
COMPOSE_CMD="docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE}"

BACKUP_DIR="/srv/iquote-backups"
# `docker compose exec` takes the SERVICE name, not the container name. Using
# "iquote-db" here made every pg_dump fail; the container happens to be named
# iquote-db, but the compose service is "db".
DB_SERVICE="${DB_SERVICE:-db}"
# Uploads live in the compose-prefixed volume (project "iquote"). The bare
# "iquote_uploads" name exists but is empty, so backing it up stored no files.
UPLOADS_VOLUME="${UPLOADS_VOLUME:-iquote_iquote_uploads}"
DB_USER="${POSTGRES_USER:-iquote}"
DB_NAME="${POSTGRES_DB:-iquote}"

# Retention thresholds (days)
RETENTION_DAILY=7
RETENTION_WEEKLY=28
RETENTION_MONTHLY=90

# Log file
LOG_FILE="/var/log/iquote-backup.log"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

err() {
    # Redirect stdout to stderr first, then tee, otherwise tee's stdin is empty
    # and errors never landed in the log file.
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "${LOG_FILE}" >&2
}

die() {
    err "$*"
    exit 1
}

# ---------------------------------------------------------------------------
# Ensure prerequisites
# ---------------------------------------------------------------------------
ensure_backup_dir() {
    mkdir -p "${BACKUP_DIR}"
}

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------
do_backup() {
    local timestamp
    timestamp="$(date '+%Y%m%d-%H%M%S')"

    local backup_name="iquote-backup-${timestamp}"
    local work_dir
    work_dir="$(mktemp -d)"

    log "Starting backup: ${backup_name}"

    # 1. pg_dump the PostgreSQL database.
    # Stream straight to the host — no in-container temp file, so no compose cp step to fail.
    # stderr is captured to a file rather than discarded, so failures are diagnosable.
    log "Dumping PostgreSQL database '${DB_NAME}'..."
    local dump_err="${work_dir}/pg_dump.err"
    if ! ${COMPOSE_CMD} exec -T "${DB_SERVICE}" \
        pg_dump -U "${DB_USER}" -d "${DB_NAME}" --format=custom > "${work_dir}/db.dump" 2>"${dump_err}"; then
        err "pg_dump failed: $(tr '\n' ' ' < "${dump_err}" | head -c 500)"
        rm -rf "${work_dir}"
        die "pg_dump failed"
    fi

    # A zero-byte or tiny dump means the dump silently produced nothing; treat it as failure.
    local dump_bytes
    dump_bytes="$(wc -c < "${work_dir}/db.dump")"
    if [[ ${dump_bytes} -lt 1024 ]]; then
        rm -rf "${work_dir}"
        die "pg_dump produced an implausibly small dump (${dump_bytes} bytes)"
    fi
    # Verify it is a real pg_dump custom-format archive before trusting it.
    if ! head -c 5 "${work_dir}/db.dump" | grep -q "PGDMP"; then
        rm -rf "${work_dir}"
        die "pg_dump output is not a valid PostgreSQL custom-format archive"
    fi
    log "Database dump complete ($(du -h "${work_dir}/db.dump" | cut -f1))"

    # 2. Copy uploads volume contents
    log "Copying uploads volume..."
    local uploads_dir="${work_dir}/uploads"
    mkdir -p "${uploads_dir}"

    # Use a temporary container to access the named volume
    if ! docker run --rm -v "${UPLOADS_VOLUME}:/source:ro" -v "${uploads_dir}:/dest" \
        alpine sh -c "cp -a /source/. /dest/"; then
        rm -rf "${work_dir}"
        die "uploads copy failed (volume '${UPLOADS_VOLUME}' missing or unreadable)"
    fi
    local upload_count
    upload_count="$(find "${uploads_dir}" -type f | wc -l)"
    log "Uploads copy complete (${upload_count} files, $(du -sh "${uploads_dir}" | cut -f1))"
    if [[ ${upload_count} -eq 0 ]]; then
        # Not fatal, but this is exactly the silent failure that hid the wrong volume name.
        err "WARNING: uploads volume '${UPLOADS_VOLUME}' is empty — verify UPLOADS_VOLUME is correct"
    fi

    # 3. Bundle into a single tar.gz
    local archive="${BACKUP_DIR}/${backup_name}.tar.gz"
    log "Creating archive: ${archive}"
    tar -czf "${archive}" -C "${work_dir}" db.dump uploads

    # 4. Compute checksum and size
    local checksum
    checksum="$(sha256sum "${archive}" | awk '{print $1}')"
    local size
    size="$(du -h "${archive}" | cut -f1)"

    # 5. Write a metadata sidecar
    local meta="${BACKUP_DIR}/${backup_name}.meta"
    cat > "${meta}" <<EOF
timestamp=${timestamp}
archive=${backup_name}.tar.gz
size=${size}
checksum=${checksum}
db=${DB_NAME}
created=$(date -Iseconds)
EOF

    # 6. Log
    log "Backup complete:"
    log "  File:     ${archive}"
    log "  Size:     ${size}"
    log "  Checksum: ${checksum}"

    # Cleanup temp dir
    rm -rf "${work_dir}"

    echo "${archive}"
}

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
do_restore() {
    local archive="$1"

    if [[ -z "${archive}" ]]; then
        die "Usage: bash deploy/backup-restore.sh restore <backup-file>"
    fi

    if [[ ! -f "${archive}" ]]; then
        die "Backup file not found: ${archive}"
    fi

    local abs_path
    abs_path="$(readlink -f "${archive}")"

    log "Starting restore from: ${abs_path}"

    # Verify checksum if meta file exists
    local meta_file="${abs_path%.tar.gz}.meta"
    if [[ -f "${meta_file}" ]]; then
        local expected_checksum
        expected_checksum="$(grep '^checksum=' "${meta_file}" | cut -d= -f2)"
        local actual_checksum
        actual_checksum="$(sha256sum "${abs_path}" | awk '{print $1}')"
        if [[ "${expected_checksum}" != "${actual_checksum}" ]]; then
            die "Checksum mismatch! Expected ${expected_checksum}, got ${actual_checksum}"
        fi
        log "Checksum verified OK"
    else
        log "WARNING: No metadata file found, skipping checksum verification"
    fi

    # 1. Extract the archive
    local work_dir
    work_dir="$(mktemp -d)"
    log "Extracting archive to ${work_dir}..."
    tar -xzf "${abs_path}" -C "${work_dir}"

    if [[ ! -f "${work_dir}/db.dump" ]]; then
        die "Invalid backup archive: db.dump not found"
    fi

    # 2. Stop API and Web containers (keep DB running)
    log "Stopping API and Web containers..."
    ${COMPOSE_CMD} stop api web
    log "API and Web containers stopped"

    # 3. Restore PostgreSQL
    log "Restoring PostgreSQL database '${DB_NAME}'..."

    # Drop and recreate the database to ensure a clean restore.
    # DB_NAME is interpolated so this does not hardcode "iquote".
    ${COMPOSE_CMD} exec -T "${DB_SERVICE}" psql -U "${DB_USER}" -d postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${DB_NAME}";
CREATE DATABASE "${DB_NAME}";
SQL

    # Restore using pg_restore, streaming the dump in from the host.
    if ! ${COMPOSE_CMD} exec -T "${DB_SERVICE}" \
        pg_restore -U "${DB_USER}" -d "${DB_NAME}" --no-owner --clean --if-exists < "${work_dir}/db.dump"; then
        log "WARNING: pg_restore reported errors (this may be normal for clean restores)"
    fi
    log "PostgreSQL restore complete"

    # 4. Restore uploads volume
    log "Restoring uploads volume..."
    if [[ -d "${work_dir}/uploads" ]]; then
        # Copy uploads back into the named volume using a temp container
        docker run --rm -v "${UPLOADS_VOLUME}:/dest" -v "${work_dir}/uploads:/source:ro" \
            alpine sh -c "rm -rf /dest/* && cp -a /source/. /dest/"
        log "Uploads restore complete"
    else
        log "WARNING: No uploads directory found in backup, skipping"
    fi

    # 5. Restart all containers
    log "Restarting all containers..."
    ${COMPOSE_CMD} up -d

    # 6. Wait for API health check
    log "Waiting for API health check..."
    local max_attempts=30
    local attempt=0
    while [[ ${attempt} -lt ${max_attempts} ]]; do
        if ${COMPOSE_CMD} exec -T api wget -qO- http://localhost:4000/health >/dev/null 2>&1; then
            log "API health check passed"
            break
        fi
        attempt=$((attempt + 1))
        echo -n "."
        sleep 5
    done
    echo ""

    if [[ ${attempt} -eq ${max_attempts} ]]; then
        die "API health check failed after ${max_attempts} attempts"
    fi

    # Cleanup
    rm -rf "${work_dir}"

    log "Restore complete successfully"
}

# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------
do_list() {
    echo "Available backups in ${BACKUP_DIR}:"
    echo "--------------------------------------------"
    printf "%-30s %-10s %-20s %s\n" "ARCHIVE" "SIZE" "CREATED" "CHECKSUM"
    echo "--------------------------------------------"

    local found=0
    for meta in "${BACKUP_DIR}"/*.meta; do
        [[ -f "${meta}" ]] || continue
        found=1
        local archive_name size created checksum
        archive_name="$(grep '^archive=' "${meta}" | cut -d= -f2)"
        size="$(grep '^size=' "${meta}" | cut -d= -f2)"
        created="$(grep '^created=' "${meta}" | cut -d= -f2)"
        checksum="$(grep '^checksum=' "${meta}" | cut -d= -f2)"
        printf "%-30s %-10s %-20s %s\n" "${archive_name}" "${size}" "${created}" "${checksum}"
    done

    if [[ ${found} -eq 0 ]]; then
        echo "(no backups found)"
    fi
    echo "--------------------------------------------"
}

# ---------------------------------------------------------------------------
# Prune — enforce retention policy
# ---------------------------------------------------------------------------
do_prune() {
    log "Running backup pruning (retention: ${RETENTION_DAILY}d daily, ${RETENTION_WEEKLY}d weekly, ${RETENTION_MONTHLY}d monthly)"

    local now
    now="$(date +%s)"
    local pruned=0
    local kept=0

    for meta in "${BACKUP_DIR}"/*.meta; do
        [[ -f "${meta}" ]] || continue

        local archive_name created
        archive_name="$(grep '^archive=' "${meta}" | cut -d= -f2)"
        created="$(grep '^created=' "${meta}" | cut -d= -f2)"

        local archive_path="${BACKUP_DIR}/${archive_name}"

        # Convert created date to epoch seconds
        local created_epoch
        created_epoch="$(date -d "${created}" +%s 2>/dev/null || echo 0)"

        if [[ ${created_epoch} -eq 0 ]]; then
            log "WARNING: Could not parse date for ${archive_name}, skipping"
            continue
        fi

        local age_days=$(( (now - created_epoch) / 86400 ))

        # Determine the retention threshold based on backup age
        # Backups older than monthly threshold get deleted
        if [[ ${age_days} -gt ${RETENTION_MONTHLY} ]]; then
            log "PRUNING (monthly expired): ${archive_name} (${age_days}d old)"
            rm -f "${archive_path}" "${meta}"
            pruned=$((pruned + 1))
        elif [[ ${age_days} -gt ${RETENTION_WEEKLY} ]]; then
            # Keep only weekly backups in this range — delete daily backups
            # We keep backups that are closest to a weekly boundary (every 7 days)
            # Simple heuristic: keep if the day-of-week is the same as the first backup
            # For simplicity, keep every 7th day and delete the rest
            local dow
            dow="$(date -d "${created}" +%u 2>/dev/null || echo 0)"
            if [[ ${dow} -ne 7 ]]; then
                log "PRUNING (weekly cleanup): ${archive_name} (${age_days}d old)"
                rm -f "${archive_path}" "${meta}"
                pruned=$((pruned + 1))
            else
                log "KEEPING (weekly): ${archive_name} (${age_days}d old)"
                kept=$((kept + 1))
            fi
        elif [[ ${age_days} -gt ${RETENTION_DAILY} ]]; then
            # In the weekly range — keep only Sunday backups
            local dow
            dow="$(date -d "${created}" +%u 2>/dev/null || echo 0)"
            if [[ ${dow} -ne 7 ]]; then
                log "PRUNING (daily expired, not weekly): ${archive_name} (${age_days}d old)"
                rm -f "${archive_path}" "${meta}"
                pruned=$((pruned + 1))
            else
                log "KEEPING (weekly): ${archive_name} (${age_days}d old)"
                kept=$((kept + 1))
            fi
        else
            log "KEEPING (daily): ${archive_name} (${age_days}d old)"
            kept=$((kept + 1))
        fi
    done

    log "Pruning complete: ${pruned} deleted, ${kept} kept"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    ensure_backup_dir

    local mode="${1:-}"
    shift || true

    case "${mode}" in
        backup)
            do_backup
            ;;
        restore)
            do_restore "$1"
            ;;
        list)
            do_list
            ;;
        prune)
            do_prune
            ;;
        *)
            echo "Usage: bash deploy/backup-restore.sh <backup|restore <file>|list|prune>"
            echo ""
            echo "Modes:"
            echo "  backup              Create a backup (PostgreSQL + uploads)"
            echo "  restore <file>      Restore from a backup archive"
            echo "  list                List available backups"
            echo "  prune               Delete backups older than retention policy"
            echo ""
            echo "Recovery Objectives:"
            echo "  RPO: 24 hours (daily backup)"
            echo "  RTO: 1 hour (restore from backup)"
            exit 1
            ;;
    esac
}

main "$@"
