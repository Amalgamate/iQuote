# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl git

COPY package*.json ./
COPY prisma ./prisma
RUN npm install

COPY . .
RUN npx prisma generate
RUN npx tsc

# Capture build metadata for /api/version
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
RUN echo "GIT_COMMIT=${GIT_COMMIT}" >> .env.production.defaults && \
    echo "BUILD_TIME=${BUILD_TIME}" >> .env.production.defaults

# ---- Production stage ----
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init openssl ca-certificates

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Build metadata for /api/version endpoint
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV BUILD_TIME=${BUILD_TIME}
ENV APP_VERSION=1.0.0

# Directory for uploaded logos (mounted as a volume in production)
RUN mkdir -p /app/uploads

EXPOSE 4000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
