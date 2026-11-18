#!/usr/bin/env bash
# Wildcard SSL certificate issuance for *.trendscore.co.ke
# Uses manual DNS challenge with a custom auth hook that waits for DNS propagation.

set -euo pipefail

DOMAIN="*.trendscore.co.ke"
ALT_DOMAIN="trendscore.co.ke"
EMAIL="admin@trendscore.co.ke"
HOOK_DIR="/tmp/certbot-dns-hook"

# Create the auth hook directory
mkdir -p "$HOOK_DIR"

# Write the auth hook script
cat > "$HOOK_DIR/auth.sh" <<'HOOKEOF'
#!/usr/bin/env bash
# This script is called by certbot with CERTBOT_DOMAIN and CERTBOT_VALIDATION env vars.
# It should create the DNS TXT record and wait for propagation.
echo ""
echo "========================================================"
echo "  DNS CHALLENGE REQUIRED"
echo "========================================================"
echo ""
echo "  Please add a TXT record to your DNS:"
echo ""
echo "    Type:  TXT"
echo "    Name:  _acme-challenge.${CERTBOT_DOMAIN}"
echo "    Value: ${CERTBOT_VALIDATION}"
echo ""
echo "  Current DNS value (if any):"
dig TXT "_acme-challenge.${CERTBOT_DOMAIN}" +short 2>/dev/null || echo "    (not found)"
echo ""
echo "  Waiting for DNS propagation..."
echo "  (Add the record in your Cloudoon dashboard, then this will auto-detect it)"
echo ""

# Wait for the TXT record to appear in DNS
for i in $(seq 1 60); do
    sleep 10
    CURRENT=$(dig TXT "_acme-challenge.${CERTBOT_DOMAIN}" +short 2>/dev/null | tr -d '"')
    if [ "$CURRENT" = "$CERTBOT_VALIDATION" ]; then
        echo "  ✓ DNS record verified after $((i * 10)) seconds!"
        exit 0
    fi
    echo "  ... checking ($((i * 10))s elapsed, found: ${CURRENT:-none})"
done

echo "  ✗ DNS record not found after 10 minutes."
echo "  Make sure you've added the TXT record correctly."
exit 1
HOOKEOF

# Write the cleanup hook script
cat > "$HOOK_DIR/cleanup.sh" <<'CLEANUPEOF'
#!/usr/bin/env bash
# Cleanup hook - TXT record can be removed manually from DNS after.
echo "  You can now remove the TXT record _acme-challenge.${CERTBOT_DOMAIN} from your DNS."
CLEANUPEOF

chmod +x "$HOOK_DIR/auth.sh" "$HOOK_DIR/cleanup.sh"

echo "=== Wildcard SSL Certificate Issuance ==="
echo ""
echo "  Certbot will run with a DNS auth hook."
echo "  When it generates a challenge, ADD the TXT record to your Cloudoon DNS."
echo "  The hook script will automatically wait and verify DNS propagation."
echo ""

certbot certonly \
    --manual \
    --preferred-challenges dns \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN" \
    -d "$ALT_DOMAIN" \
    --manual-auth-hook "$HOOK_DIR/auth.sh" \
    --manual-cleanup-hook "$HOOK_DIR/cleanup.sh" \
    --non-interactive

echo ""
echo "=== Certificate issued successfully! ==="
echo "  Certificate: /etc/letsencrypt/live/trendscore.co.ke/fullchain.pem"
echo "  Key: /etc/letsencrypt/live/trendscore.co.ke/privkey.pem"
