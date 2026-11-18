#!/usr/bin/env bash
# Single auth hook that writes the challenge to a file and waits for DNS propagation.
# This handles both challenges (wildcard + bare domain) in sequence.

set -euo pipefail

CHALLENGE_FILE="/tmp/certbot-challenge.txt"
LOG_FILE="/tmp/certbot-hook-progress.log"

echo "$(date): Hook called for domain=${CERTBOT_DOMAIN} validation=${CERTBOT_VALIDATION} remaining=${CERTBOT_REMAINING_CHALLENGES}" >> "$LOG_FILE"

# Append the challenge to the file so we can see all challenges
echo "domain=${CERTBOT_DOMAIN} validation=${CERTBOT_VALIDATION}" >> "$CHALLENGE_FILE"

echo ""
echo "========================================================"
echo "  DNS CHALLENGE for ${CERTBOT_DOMAIN}"
echo "  Add TXT record: _acme-challenge.${CERTBOT_DOMAIN} = ${CERTBOT_VALIDATION}"
echo "========================================================"
echo ""

# Wait for this specific validation to appear in DNS
for i in $(seq 1 90); do  # 15 minutes
    sleep 10
    CURRENT=$(dig TXT "_acme-challenge.${CERTBOT_DOMAIN}" +short 2>/dev/null | tr -d '"')
    if echo "$CURRENT" | grep -qF "$CERTBOT_VALIDATION"; then
        echo "$(date): VERIFIED after $((i * 10))s" >> "$LOG_FILE"
        echo "  VERIFIED after $((i * 10)) seconds!"
        exit 0
    fi
    echo "$(date): waiting ($((i * 10))s), found: ${CURRENT:-none}" >> "$LOG_FILE"
done

echo "$(date): TIMEOUT" >> "$LOG_FILE"
exit 1
