# Edge Verification — TLS, Redirects & Security Headers

Production endpoint: **https://iquote.trendscore.co.ke**
Server: 185.127.16.124 (SSH alias: `production`)
Host Nginx reverse proxy: `deploy/nginx-iquote.conf` → container port 5180

This document describes how to verify and harden the public edge: TLS
termination, HTTP→HTTPS redirect, tenant wildcard certificate state, and
security headers including HSTS and CSP.

---

## 1. TLS Termination Verification

The primary certificate (`iquote.trendscore.co.ke`) was issued by Let's
Encrypt via Certbot. The host Nginx terminates TLS on port 443 and proxies
plain HTTP to the web container on 127.0.0.1:5180.

### Check certificate validity, issuer, and subject

```bash
echo | openssl s_client -connect iquote.trendscore.co.ke:443 2>/dev/null \
  | openssl x509 -noout -dates -issuer -subject
```

Expected output:
```
notBefore=Feb  XX XX:XX:XX 2026 GMT
notAfter=Feb  XX XX:XX:XX 2027 GMT
issuer=C=US, O=Let's Encrypt, CN=R3
subject=CN=iquote.trendscore.co.ke
```

The cert is valid until February 2027.

### Check certificate chain and verification depth

```bash
echo | openssl s_client -connect iquote.trendscore.co.ke:443 -showcerts 2>/dev/null \
  | grep -E 'Verify|depth'
```

Expected: `Verify return code: 0 (ok)` with chain depth 0-2.

### Verify auto-renewal (dry run)

```bash
sudo certbot renew --dry-run
```

This simulates renewal for all Let's Encrypt certs on the server. It should
complete without error.

### Check the renewal timer

```bash
systemctl status certbot.timer
```

Confirm the timer is `active (running)` and the next trigger is within the
next 12 hours (Certbot checks twice daily by default).

---

## 2. HTTP → HTTPS Redirect

### Current state

The `nginx-iquote.conf` in this repo defines a single `server` block that
listens on port 80 **without** an HTTPS redirect. In production, Certbot's
`--redirect` flag (run during `provision-ssl.sh`) modified the live Nginx
config to add a 301 redirect and a separate 443 server block.

**However**, the repo config file does not reflect those production changes.
After SSL provisioning, `nginx-iquote.conf` should be updated to include both
the redirect block and the HTTPS server block explicitly.

### Corrected Nginx config

Replace the contents of `deploy/nginx-iquote.conf` with the following after
SSL provisioning:

```nginx
# =============================================================
# iQuote — Nginx reverse proxy config (HTTP redirect + HTTPS)
# =============================================================
# Placed at /etc/nginx/sites-available/iquote.trendscore.co.ke
# The iQuote web container listens on host port 5180.
# =============================================================

# --- HTTP → HTTPS redirect ---
server {
    listen 80;
    listen [::]:80;
    server_name iquote.trendscore.co.ke www.iquote.trendscore.co.ke;

    # Preserve ACME challenge path for renewals
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Redirect everything else to HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

# --- HTTPS server block ---
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name iquote.trendscore.co.ke www.iquote.trendscore.co.ke;

    # SSL certificate paths (managed by Certbot)
    ssl_certificate     /etc/letsencrypt/live/iquote.trendscore.co.ke/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/iquote.trendscore.co.ke/privkey.pem;

    # TLS settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 10m;
    proxy_read_timeout 60s;
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;

    # Security headers
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # HSTS — enable only after all traffic is HTTPS (see section 5)
    # add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Content-Security-Policy — enable after testing (see section 4)
    # add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'" always;

    location / {
        proxy_pass http://127.0.0.1:5180;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Verify the redirect is active

```bash
curl -sI http://iquote.trendscore.co.ke | grep -i location
```

Expected:
```
location: https://iquote.trendscore.co.ke/
```

The response code should be `301 Moved Permanently`.

### After updating the config file on the server

```bash
sudo cp deploy/nginx-iquote.conf /etc/nginx/sites-available/iquote.trendscore.co.ke
sudo ln -sfn /etc/nginx/sites-available/iquote.trendscore.co.ke /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 3. Tenant Wildcard Certificate State

### Current state

| Component | Status |
|---|---|
| `deploy/nginx-wildcard.conf` | HTTP-only (listen 80, no SSL) |
| Wildcard cert `*.trendscore.co.ke` | **Not provisioned** |
| DNS provider | Cloudoon DNS panel |
| Auth hook | `deploy/certbot-auth-hook.sh` (waits for DNS propagation) |
| Wildcard issuance script | `deploy/wildcard-ssl.sh` |

Tenant subdomains (e.g., `acme.trendscore.co.ke`) currently route over
**HTTP only**. This is not suitable for production traffic — tenant data
would transit unencrypted.

### Steps to provision the wildcard certificate

1. **Set up DNS TXT record via Cloudoon panel**

   When Certbot runs the DNS-01 challenge, it outputs a validation string.
   You must create a TXT record in the Cloudoon DNS dashboard:

   ```
   Type:  TXT
   Name:  _acme-challenge.trendscore.co.ke
   Value: <validation string from certbot>
   ```

2. **Issue the certificate**

   Use the wildcard SSL script which invokes Certbot with the DNS auth hook:

   ```bash
   sudo bash deploy/wildcard-ssl.sh
   ```

   Or run Certbot directly with the auth hook from this repo:

   ```bash
   sudo certbot certonly \
     --manual \
     --preferred-challenges dns \
     --agree-tos \
     --email admin@trendscore.co.ke \
     -d '*.trendscore.co.ke' \
     -d 'trendscore.co.ke' \
     --manual-auth-hook deploy/certbot-auth-hook.sh \
     --non-interactive
   ```

   The auth hook (`certbot-auth-hook.sh`) automatically:
   - Prints the TXT record to add
   - Polls DNS every 10 seconds for up to 15 minutes
   - Exits 0 once the record propagates, allowing Certbot to proceed

3. **Verify the certificate was issued**

   ```bash
   sudo certbot certificates --cert-name trendscore.co.ke
   ```

   The certificate files will be at:
   - `/etc/letsencrypt/live/trendscore.co.ke/fullchain.pem`
   - `/etc/letsencrypt/live/trendscore.co.ke/privkey.pem`

4. **Update `nginx-wildcard.conf` to listen on 443 with SSL**

   ```nginx
   server {
       listen 80;
       listen [::]:80;
       server_name *.trendscore.co.ke;
       return 301 https://$host$request_uri;
   }

   server {
       listen 443 ssl http2;
       listen [::]:443 ssl http2;
       server_name *.trendscore.co.ke;

       ssl_certificate     /etc/letsencrypt/live/trendscore.co.ke/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/trendscore.co.ke/privkey.pem;

       ssl_protocols TLSv1.2 TLSv1.3;
       ssl_ciphers HIGH:!aNULL:!MD5;
       ssl_prefer_server_ciphers on;

       client_max_body_size 10m;
       proxy_read_timeout 60s;
       proxy_connect_timeout 60s;
       proxy_send_timeout 60s;

       # Security headers (same as primary domain)
       add_header X-Content-Type-Options "nosniff" always;
       add_header X-Frame-Options "DENY" always;
       add_header X-XSS-Protection "1; mode=block" always;
       add_header Referrer-Policy "strict-origin-when-cross-origin" always;
       add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

       # HSTS with includeSubDomains — enable after wildcard SSL is active
       # add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

       location / {
           proxy_pass http://127.0.0.1:5180;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }
   }
   ```

5. **Enable and reload Nginx**

   ```bash
   sudo cp deploy/nginx-wildcard.conf /etc/nginx/sites-available/iquote-wildcard.trendscore.co.ke
   sudo ln -sfn /etc/nginx/sites-available/iquote-wildcard.trendscore.co.ke /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

6. **Verify the wildcard cert**

   ```bash
   echo | openssl s_client -connect acme.trendscore.co.ke:443 2>/dev/null \
     | openssl x509 -noout -dates -issuer -subject
   ```

### Important note on wildcard renewal

Wildcard certificates issued via manual DNS challenge **cannot auto-renew**
without a DNS API plugin. Before the cert expires (90 days), you must
re-run the provisioning steps. Consider setting up a Cloudoon DNS API
plugin for Certbot if available, to enable fully automated renewal.

---

## 4. Security Headers Verification

### Verify all headers currently served

```bash
curl -sI https://iquote.trendscore.co.ke
```

### Expected headers (already in `nginx-iquote.conf`)

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-XSS-Protection` | `1; mode=block` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

Verify with a single command:

```bash
curl -sI https://iquote.trendscore.co.ke/health \
  | grep -iE 'x-content|x-frame|x-xss|referrer|permissions'
```

### Missing headers to add

#### Strict-Transport-Security (HSTS)

See section 5 below. This should be added **after** confirming all traffic
routes through HTTPS and the wildcard certificate is active.

#### Content-Security-Policy (CSP)

A basic CSP restricts which sources can load scripts, styles, and other
resources. Start conservative and adjust based on application needs.

Nginx directive:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'" always;
```

Policy breakdown:
- `default-src 'self'` — only load resources from the same origin
- `script-src 'self'` — scripts only from same origin (no inline scripts)
- `style-src 'self' 'unsafe-inline'` — styles from same origin, allow inline (common for frameworks)
- `img-src 'self' data: https:` — images from same origin, data URIs, and HTTPS sources
- `connect-src 'self'` — XHR/fetch/WebSocket only to same origin
- `font-src 'self'` — fonts from same origin
- `object-src 'none'` — no Flash/Java plugins
- `frame-ancestors 'none'` — prevent clickjacking (supplements X-Frame-Options)
- `base-uri 'self'` — restrict `<base>` tag

**Test before enabling**: Load the application with the CSP in report-only
mode first to catch any violations:

```nginx
add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'" always;
```

Once no violations appear in the browser console, switch to enforcing mode.

---

## 5. HSTS Configuration

### When to enable

HSTS tells browsers to **always** use HTTPS for the domain, preventing
protocol downgrade attacks. Enable HSTS **only after**:

1. The HTTP→HTTPS redirect is confirmed working (section 2)
2. All traffic routes through HTTPS (no mixed-content issues)
3. The wildcard certificate for `*.trendscore.co.ke` is provisioned (section 3)

### Nginx directive (primary domain)

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

- `max-age=31536000` — 1 year (browsers will remember to use HTTPS)
- `includeSubDomains` — applies HSTS to all subdomains (`*.trendscore.co.ke`)
- `always` — ensures the header is sent even on error responses (4xx, 5xx)

### Without subdomains (before wildcard cert)

If the wildcard cert is not yet active, use this safer version that does
**not** include subdomains:

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

### Deployment sequence

1. Verify redirect: `curl -sI http://iquote.trendscore.co.ke` → 301 to HTTPS
2. Verify TLS: `echo | openssl s_client -connect iquote.trendscore.co.ke:443 ...`
3. Uncomment the HSTS line in the HTTPS server block
4. Reload Nginx: `sudo nginx -t && sudo systemctl reload nginx`
5. Verify: `curl -sI https://iquote.trendscore.co.ke | grep -i strict-transport`

### Rollback caution

HSTS is cached by browsers for the `max-age` duration and **cannot be
easily undone**. If you need to disable HTTPS temporarily, set a very short
`max-age` first (e.g., `max-age=60`), deploy, wait 24 hours, then remove
the header entirely.

---

## 6. Verification Commands Summary

Copy-paste block to verify the entire edge from any machine:

```bash
# === TLS Certificate ===
echo | openssl s_client -connect iquote.trendscore.co.ke:443 2>/dev/null \
  | openssl x509 -noout -dates -issuer

# === Certificate Chain ===
echo | openssl s_client -connect iquote.trendscore.co.ke:443 -showcerts 2>/dev/null \
  | grep -E 'Verify|depth'

# === HTTP → HTTPS Redirect ===
curl -sI http://iquote.trendscore.co.ke/health

# === Security Headers ===
curl -sI https://iquote.trendscore.co.ke/health \
  | grep -iE 'x-content|x-frame|x-xss|referrer|permissions|strict-transport'

# === Container Health ===
curl -s https://iquote.trendscore.co.ke/health

# === API Version ===
curl -s https://iquote.trendscore.co.ke/api/version

# === Certbot Renewal (dry run) — run on the server ===
# sudo certbot renew --dry-run

# === Certbot Timer Status — run on the server ===
# systemctl status certbot.timer

# === Tenant Subdomain TLS (after wildcard cert provisioning) ===
# echo | openssl s_client -connect acme.trendscore.co.ke:443 2>/dev/null \
#   | openssl x509 -noout -dates -issuer -subject
```

### Quick one-liner for all edge checks

```bash
echo "--- TLS ---" && echo | openssl s_client -connect iquote.trendscore.co.ke:443 2>/dev/null | openssl x509 -noout -dates -issuer && echo "--- Redirect ---" && curl -sI http://iquote.trendscore.co.ke/health | head -5 && echo "--- Headers ---" && curl -sI https://iquote.trendscore.co.ke/health | grep -iE 'x-content|x-frame|x-xss|referrer|permissions|strict-transport' && echo "--- Health ---" && curl -s https://iquote.trendscore.co.ke/health && echo "" && echo "--- Version ---" && curl -s https://iquote.trendscore.co.ke/api/version
```
