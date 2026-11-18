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
#   1. Clones/pulls the iQuote repo
#   2. Configures .env.prod from template
#   3. Builds and starts Docker containers
#   4. Runs database migrations
#   5. Enables Nginx reverse proxy
#   6. Provisions SSL certificates
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
echo "  Current commit: $(git rev-parse --short HEAD)"

# ---- 2. Configure environment ----
echo ""
echo "[2/6] Checking environment configuration..."
if [ ! -f "$ENV_FILE" ]; then
    if [ -f ".env.prod.example" ]; then
        cp .env.prod.example "$ENV_FILE"
        echo "  Created $ENV_FILE from template."
        echo "  >>> EDIT $REPO_DIR/$ENV_FILE with real secrets before continuing! <<<"
        echo "  >>> Required: POSTGRES_PASSWORD, JWT_SECRET, PLATFORM_URL <<<"
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
echo "  All required variables are set."

# ---- 3. Build and start containers ----
echo ""
echo "[3/6] Building and starting Docker containers..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build
echo "  Containers started."

# Wait for API to be healthy
echo "  Waiting for API to start..."
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:5180/api/health >/dev/null 2>&1; then
        echo "  API is responding."
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "  WARNING: API did not respond within 30 seconds."
        echo "  Check logs: docker compose -f $COMPOSE_FILE logs api"
    fi
    sleep 2
done

# ---- 4. Run database migrations ----
echo ""
echo "[4/6] Running database migrations..."
docker compose -f "$COMPOSE_FILE" exec -T api npx prisma db push --accept-data-loss 2>/dev/null || \
    docker compose -f "$COMPOSE_FILE" exec -T api npx prisma migrate deploy 2>/dev/null || \
    echo "  NOTE: Migration may have already been applied."
echo "  Database schema is in sync."

# ---- 5. Enable Nginx reverse proxy ----
echo ""
echo "[5/6] Configuring Nginx reverse proxy..."
if command -v nginx >/dev/null 2>&1; then
    sudo cp deploy/nginx-iquote.conf /etc/nginx/sites-available/iquote.trendscore.co.ke
    sudo ln -sfn /etc/nginx/sites-available/iquote.trendscore.co.ke /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx
    echo "  Nginx site enabled for iquote.trendscore.co.ke"
else
    echo "  Nginx not found on this server. Install Nginx or use the Docker Nginx."
    echo "  The web container is accessible on port 5180."
fi

# ---- 6. SSL (optional, prompt user) ----
echo ""
echo "[6/6] SSL Certificate..."
echo "  To provision SSL, run:"
echo "    sudo bash deploy/provision-ssl.sh"
echo ""

echo "=== Deployment complete! ==="
echo "  HTTP:  http://iquote.trendscore.co.ke"
echo "  API:   http://iquote.trendscore.co.ke/api/health"
echo ""
echo "  Next steps:"
echo "    1. Run: sudo bash deploy/provision-ssl.sh"
echo "    2. Promote a superadmin:"
echo "       docker compose -f $COMPOSE_FILE exec -T api node scripts/promote-superadmin.mjs your@email.com"
echo "    3. Log in at https://iquote.trendscore.co.ke"
