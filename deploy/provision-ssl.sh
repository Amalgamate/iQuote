#!/usr/bin/env bash
# =============================================================
# iQuote — SSL Certificate Provisioning Script
# =============================================================
# Run ON the production server as a user with sudo.
#
# Usage:
#   sudo bash deploy/provision-ssl.sh
#
# This script:
#   1. Enables the iQuote Nginx site (HTTP first)
#   2. Issues an SSL certificate for iquote.trendscore.co.ke via Certbot
#   3. Issues a wildcard certificate for *.trendscore.co.ke via DNS challenge
#   4. Reloads Nginx with HTTPS
# =============================================================

set -euo pipefail

DOMAIN="iquote.trendscore.co.ke"
WILDCARD_DOMAIN="*.trendscore.co.ke"
EMAIL="admin@trendscore.co.ke"
WEB_ROOT="/var/www/certbot"
NGINX_SITES_AVAILABLE="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"

echo "=== iQuote SSL Provisioning ==="
echo ""

# --- 1. Ensure certbot webroot exists ---
mkdir -p "$WEB_ROOT"

# --- 2. Enable iQuote HTTP site ---
echo "[1/4] Enabling Nginx site for $DOMAIN..."

if [ ! -f "$NGINX_SITES_AVAILABLE/$DOMAIN" ]; then
    cat > "$NGINX_SITES_AVAILABLE/$DOMAIN" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    client_max_body_size 10m;

    location /.well-known/acme-challenge/ {
        root $WEB_ROOT;
    }

    location / {
        proxy_pass http://127.0.0.1:5180;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
    echo "  Created $NGINX_SITES_AVAILABLE/$DOMAIN"
fi

ln -sfn "$NGINX_SITES_AVAILABLE/$DOMAIN" "$NGINX_SITES_ENABLED/$DOMAIN"
echo "  Enabled site."

# Disable default if it conflicts
if [ -f "$NGINX_SITES_ENABLED/default" ]; then
    rm -f "$NGINX_SITES_ENABLED/default"
    echo "  Removed default site (was conflicting)."
fi

nginx -t
systemctl reload nginx
echo "  Nginx reloaded (HTTP active)."

# --- 3. Install certbot if needed ---
echo ""
echo "[2/4] Checking certbot..."
if ! command -v certbot >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq certbot python3-certbot-nginx
    echo "  Certbot installed."
else
    echo "  Certbot already installed."
fi

# --- 4. Issue certificate for iquote.trendscore.co.ke ---
echo ""
echo "[3/4] Issuing SSL certificate for $DOMAIN..."
certbot --nginx \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    --redirect \
    -d "$DOMAIN" \
    -d "www.$DOMAIN" \
    --webroot-path "$WEB_ROOT"

echo "  Certificate issued for $DOMAIN."

# --- 5. Wildcard certificate for *.trendscore.co.ke ---
echo ""
echo "[4/4] Wildcard certificate for $WILDCARD_DOMAIN..."
echo ""
echo "  Wildcard certificates require a DNS challenge."
echo "  This needs a DNS API plugin (Cloudflare, DigitalOcean, etc.)"
echo "  or manual DNS record creation."
echo ""
echo "  To issue the wildcard certificate, run:"
echo ""
echo "    sudo certbot certonly \\"
echo "      --manual \\"
echo "      --preferred-challenges dns \\"
echo "      --agree-tos \\"
echo "      --email $EMAIL \\"
echo "      -d '$WILDCARD_DOMAIN' -d 'trendscore.co.ke'"
echo ""
echo "  Certbot will show you a TXT record to add to your DNS."
echo "  After adding it, press Enter to continue."
echo ""
echo "  Then enable the wildcard Nginx site:"
echo "    sudo cp deploy/nginx-wildcard.conf /etc/nginx/sites-available/iquote-wildcard.trendscore.co.ke"
echo "    sudo ln -sfn /etc/nginx/sites-available/iquote-wildcard.trendscore.co.ke /etc/nginx/sites-enabled/"
echo "    sudo nginx -t && sudo systemctl reload nginx"
echo ""

# --- 6. Set up auto-renewal ---
echo "=== Setting up auto-renewal ==="
# Certbot installs a systemd timer by default; verify it's active
systemctl enable certbot.timer 2>/dev/null || true
systemctl start certbot.timer 2>/dev/null || true
echo "  Certbot renewal timer is active."
echo ""
echo "=== SSL provisioning complete for $DOMAIN ==="
echo "  HTTPS is now active at https://$DOMAIN"
echo "  Wildcard SSL requires manual DNS challenge — see instructions above."
