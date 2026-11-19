# Use full Node (Debian) so native modules (bcrypt, sharp) build/run without Alpine issues
FROM node:20-bookworm-slim

# Install dumb-init for proper signal handling
# Install runtime utilities: dumb-init for signals and postgresql-client for pg_dump R2 backups
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init postgresql-client && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

ENV NODE_ENV=production

# Install dependencies (production only) - full image has prebuilt binaries for bcrypt/sharp
RUN npm ci --omit=dev && npm cache clean --force

# Copy source code
COPY . .

# Create necessary directories
RUN mkdir -p whatsapp_sessions uploads

# Set proper permissions
RUN chown -R node:node /app

# Switch to non-root user for security
USER node

EXPOSE 8080

# Health check - use /ping (no DB dependency) so container stays healthy even if DB is down
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/ping', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start app
CMD ["node", "src/app.js"]
