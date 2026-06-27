# ──────────────────────────────────────────────────────────────────────────────
# KYC Copilot — Production Dockerfile
# Multi-stage build on Playwright base image for browser-based KYC evidence
# gathering. Final stage runs as non-root `node` user (AMLD6 compliance).
# Playwright base image is pinned to match `playwright` in package.json.
# ──────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Install production dependencies ─────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS deps

WORKDIR /app

# Copy only package files for layer caching
COPY package.json package-lock.json ./

# Install production deps only (skip devDependencies).
# --legacy-peer-deps needed for @langchain/* peer resolution.
# --ignore-scripts prevents native addon rebuilds that need dev headers.
RUN npm ci --omit=dev --legacy-peer-deps --ignore-scripts && \
    # Rebuild only the native addons we actually need (bcrypt, pg-native)
    npm rebuild bcrypt 2>/dev/null || true && \
    # Remove npm cache to reduce image size
    npm cache clean --force

# ── Stage 2: Build TypeScript ────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS build

WORKDIR /app

# Full install (including devDependencies for tsc)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --ignore-scripts && \
    npm rebuild bcrypt 2>/dev/null || true

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

RUN npm run typecheck && npm run build

# ── Stage 3: Production runtime ─────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS runtime

# Metadata labels (OCI standard)
LABEL org.opencontainers.image.title="kyc-copilot" \
      org.opencontainers.image.description="Agentic AML/KYC compliance platform" \
      org.opencontainers.image.vendor="Kakashi3lite" \
      org.opencontainers.image.source="https://github.com/kakashi3lite/kyc-copilot"

WORKDIR /app

# Environment defaults
ENV NODE_ENV=production \
    PORT=3000 \
    # Tell Playwright to use the pre-installed browsers in the base image
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Disable Playwright's download-on-first-run behavior
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy production node_modules from deps stage (no devDependencies)
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled JS and static assets from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json

# Copy DB migrations into the runtime image so `dist/src/db/migrate.js`
# (Fly's release_command) can find them at /app/src/db/migrations.
# drizzle's migrator reads meta/_journal.json + meta/*.json snapshots in
# addition to the SQL files, so the whole folder is required.
COPY --from=build /app/src/db/migrations ./src/db/migrations

# Create data directory for any local storage needs
RUN mkdir -p /app/data && \
    # Ensure the non-root 'node' user owns everything
    # (The Playwright base image already has a 'pwuser', but we use the
    # standard 'node' user that ships with the Node.js base layer)
    chown -R 1000:1000 /app

# Drop to non-root user — required for AMLD6 compliance hardening
USER 1000

EXPOSE 3000

# Health check — Fly.io also probes via [http_service] but this helps
# docker-compose and local testing
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/src/index.js"]
