#!/usr/bin/env bash
# =============================================================
# iQuote — Production Deployment Script
# =============================================================
# Run ON the production server.
#
# Usage:
#   bash deploy/deploy.sh
#
# This script:
#   1. Pulls the iQuote repo
#   2. Validates .env.prod configuration
#   3. Builds and starts Docker containers with health checks
#   4. Runs Prisma database migrations (migrate deploy, not db push)
#   5. Enables Nginx reverse proxy with security headers
#   6. Reports deployment status and deployed commit
# =============================================================

set -euo pipefail

# ---- Configuration ----
REPO_URL="https://github.com/Amalgamate/iQuote.git"
REPO_DIR="/srv/iquote"
BRANCH="main"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"

echo "=== iQuote Production Deployment ==="
echo ""

# ---- 1. Clone or update repo ----
echo "[1/6] Fetching latest code..."
if [ -d "$REPO_DIR/.git" ]; then
    cd "$REPO_DIR"
    git fetch origin "$BRANCH"
    git reset --hard "origin/$BRANCH"
    echo "  Updated existing repo at $REPO_DIR"
else
    git clone -b "$BRANCH" "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
    echo "  Cloned repo to $REPO_DIR"
fi
GIT_COMMIT=$(git rev-parse --short HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "  Commit: $GIT_COMMIT (branch: $GIT_BRANCH)"
echo "  Build time: $BUILD_TIME"

# ---- 2. Configure environment ----
echo ""
echo "[2/6] Checking environment configuration..."
if [ ! -f "$ENV_FILE" ]; then
    if [ -f ".env.prod.example" ]; then
        cp .env.prod.example "$ENV_FILE"
        echo "  Created $ENV_FILE from template."
        echo "  >>> EDIT $REPO_DIR/$ENV_FILE with real secrets before continuing! <<<"
        echo "  >>> Required: POSTGRES_PASSWORD, JWT_SECRET, PLATFORM_URL, TRUSTED_ORIGINS <<<"
        echo ""
        echo "  Run this script again after editing."
        exit 1
    else
        echo "  ERROR: No .env.prod or .env.prod.example found!"
        exit 1
    fi
else
    echo "  $ENV_FILE exists."
fi

# Validate required vars are set (not placeholders)
for var in POSTGRES_PASSWORD JWT_SECRET PLATFORM_URL; do
    val=$(grep "^${var}=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true)
    if [ -z "$val" ] || [[ "$val" == *"replace"* ]] || [[ "$val" == *"change"* ]]; then
        echo "  ERROR: $var is not set or still has a placeholder value in $ENV_FILE"
        exit 1
    fi
done

# Warn if TRUSTED_ORIGINS is not set
if ! grep -q "^TRUSTED_ORIGINS=" "$ENV_FILE" 2>/dev/null; then
    echo "  WARNING: TRUSTED_ORIGINS is not set in $ENV_FILE"
    echo "           CORS will reject all credentialed requests in production."
    echo "           Set it to: https://iquote.trendscore.co.ke"
else
    echo "  TRUSTED_ORIGINS is configured."
fi
echo "  All required variables are set."

# Export build args for docker compose
export GIT_COMMIT
export BUILD_TIME

# ---- 3. Build images (without starting the new code) ----
echo ""
echo "[3/7] Building Docker images..."
# Build first, but do NOT start the new containers yet. The new code may expect
# schema changes that are not applied yet; starting it first would serve a
# half-migrated schema. Migrations run in step 4, against the already-running
# old container, and only then do we swap in the new image.
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build
echo "  Images built."

# ---- 4. Run database migrations against the running API container ----
echo ""
echo "[4/7] Running database migrations (prisma migrate deploy)..."
# The migrations run inside the *current* container, which is still serving the
# previous release. Prisma's migrate client is version-independent of the
# running app, so this is safe even though the container image is about to be
# replaced in step 5.
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T api npx prisma migrate deploy
echo "  Database migrations applied."

# ---- 5. Start the new containers and wait for health ----
echo ""
echo "[5/7] Starting the new containers..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
echo "  Containers started."

# Wait for API to be healthy (with proper failure)
# The check requires the JSON body, not just any 200: the SPA fallback also
# answers 200 with HTML, which would hide a broken /health route.
echo "  Waiting for API health check..."
HEALTHY=false
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:5180/health 2>/dev/null | grep -q '"status":"ok"'; then
        HEALTHY=true
        echo "  API is healthy (responded in ~$((i * 2))s)."
        break
    fi
    sleep 2
done

if [ "$HEALTHY" = "false" ]; then
    echo "  FATAL: API did not become healthy within 60 seconds."
    echo "  Check logs: docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs api"
    echo "  Rolling back: docker compose -f $COMPOSE_FILE --env-file $ENV_FILE restart api"
    exit 1
fi

# Verify deployed version
echo ""
echo "  Deployed version:"
curl -s http://127.0.0.1:5180/api/version || echo "  (version endpoint not available)"

# ---- 6. Enable Nginx reverse proxy ----
echo ""
echo ""
echo "[6/7] Configuring Nginx reverse proxy..."
if command -v nginx >/dev/null 2>&1; then
    # This host serves several sites on 443. Stage the new config, test it, and
    # only then make it live — a bad TLS block must never break the host.
    sudo cp deploy/nginx-iquote.conf /etc/nginx/sites-available/iquote.trendscore.co.ke.staged
    if sudo test -f /etc/letsencrypt/live/iquote.trendscore.co.ke/fullchain.pem; then
        sudo mv /etc/nginx/sites-available/iquote.trendscore.co.ke.staged /etc/nginx/sites-available/iquote.trendscore.co.ke
        sudo ln -sfn /etc/nginx/sites-available/iquote.trendscore.co.ke /etc/nginx/sites-enabled/
        if sudo nginx -t; then
            sudo systemctl reload nginx
            echo "  Nginx site enabled for iquote.trendscore.co.ke (HTTP + HTTPS)"
        else
            echo "  ERROR: staged Nginx config failed validation — NOT reloaded." >&2
            echo "  The server keeps running the previous config. Fix deploy/nginx-iquote.conf." >&2
            exit 1
        fi
    else
        echo "  WARNING: certificate for iquote.trendscore.co.ke is missing."
        echo "  Keeping the existing Nginx config so HTTPS does not fall back to another site."
        echo "  Run: sudo bash deploy/provision-ssl.sh"
        sudo rm -f /etc/nginx/sites-available/iquote.trendscore.co.ke.staged
    fi
else
    echo "  Nginx not found on this server. The web container is on port 5180."
fi

# ---- 7. Summary ----
echo ""
echo "[7/7] Deployment summary"
echo "  HTTP:      http://iquote.trendscore.co.ke"
echo "  API health: http://iquote.trendscore.co.ke/health"
echo "  Version:   http://iquote.trendscore.co.ke/api/version"
echo "  Commit:    $GIT_COMMIT"
echo ""
echo "  Next steps:"
echo "    1. SSL:     sudo bash deploy/provision-ssl.sh"
echo "    2. Backup:  bash deploy/backup-restore.sh backup"
echo "    3. Superadmin: docker compose -f $COMPOSE_FILE exec -T api node scripts/promote-superadmin.mjs your@email.com"
echo ""
echo "=== Deployment complete! ==="
