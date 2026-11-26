# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
# In production, API calls go to same-origin /api (Nginx proxies to backend)
ENV VITE_API_URL=""
RUN npm run build

# ---- Production stage ----
FROM nginx:stable-alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx config: SPA fallback + API reverse proxy + uploads proxy
RUN printf '%s\n' \
    'server {' \
    '    listen 80;' \
    '    server_name _;' \
    '' \
    '    client_max_body_size 10m;' \
    '    gzip on;' \
    '    gzip_comp_level 5;' \
    '    gzip_min_length 1024;' \
    '    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss image/svg+xml;' \
    '' \
    '    root /usr/share/nginx/html;' \
    '    index index.html index.htm;' \
    '' \
    '    # Static assets — long cache (hashed filenames)' \
    '    location /assets/ {' \
    '        try_files $uri =404;' \
    '        add_header Cache-Control "public, max-age=31536000, immutable" always;' \
    '    }' \
    '' \
    '    # Index.html — never cache (JS bundle URL changes on deploy)' \
    '    location = /index.html {' \
    '        add_header Cache-Control "no-cache, no-store, must-revalidate" always;' \
    '    }' \
    '' \
    '    # API proxy' \
    '    location /api/ {' \
    '        proxy_pass http://api:4000/api/;' \
    '        proxy_http_version 1.1;' \
    '        proxy_set_header Host $host;' \
    '        proxy_set_header X-Real-IP $remote_addr;' \
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
    '        proxy_set_header X-Forwarded-Proto $scheme;' \
    '        proxy_read_timeout 60s;' \
    '    }' \
    '' \
    '    # API liveness probe (deploy scripts and uptime checks hit /health).' \
    '    # Without this exact match it falls through to the SPA and returns HTML.' \
    '    location = /health {' \
    '        proxy_pass http://api:4000/health;' \
    '        proxy_http_version 1.1;' \
    '        proxy_set_header Host $host;' \
    '        proxy_set_header X-Forwarded-Proto $scheme;' \
    '        access_log off;' \
    '    }' \
    '' \
    '    # Uploaded files (logos) — proxied to API container' \
    '    location /uploads/ {' \
    '        proxy_pass http://api:4000/uploads/;' \
    '        proxy_set_header Host $host;' \
    '        proxy_set_header X-Real-IP $remote_addr;' \
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
    '        proxy_set_header X-Forwarded-Proto $scheme;' \
    '        add_header Cache-Control "public, max-age=604800, immutable" always;' \
    '    }' \
    '' \
    '    # Email preview (dev only, harmless in prod)' \
    '    location /api/email-preview/ {' \
    '        proxy_pass http://api:4000/api/email-preview/;' \
    '        proxy_set_header Host $host;' \
    '    }' \
    '' \
    '    # SPA fallback' \
    '    location / {' \
    '        try_files $uri $uri/ /index.html;' \
    '        add_header Cache-Control "no-cache" always;' \
    '    }' \
    '' \
    '    add_header X-Content-Type-Options "nosniff" always;' \
    '    add_header X-Frame-Options "SAMEORIGIN" always;' \
    '    add_header Referrer-Policy "strict-origin-when-cross-origin" always;' \
    '}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
