FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# 🔥 COPY EVERYTHING (ROUTES INCLUDED)
COPY . .

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nexopa -u 1001

RUN chown -R nexopa:nodejs /usr/src/app
USER nexopa

ARG PORT=3000
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:${PORT}/api/health', r => { if (r.statusCode !== 200) throw new Error() })"

# Production must apply versioned migrations before the API starts. Running
# node src/server.js directly bypassed migrations/, which is why the database
# could contain an older chat_participants schema while the model expected
# hiddenAt/clearedAt.
CMD ["sh", "-c", "npm run db:migrate && node src/server.js"]
