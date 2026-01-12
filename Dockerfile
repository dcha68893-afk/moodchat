# Use official Node.js LTS image (Alpine variant for smaller size)
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies first (better layer caching)
COPY package*.json ./

# Install production dependencies only
# Check if package-lock.json exists, use ci if it does, install if it doesn't
RUN if [ -f package-lock.json ]; then \
      npm ci --only=production; \
    else \
      npm install --only=production; \
    fi

# Copy source code
COPY src ./src



# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S moodchat -u 1001

# Change ownership to non-root user
RUN chown -R moodchat:nodejs /usr/src/app
USER moodchat

# Expose port (default to 3000, will be overridden by .env)
ARG PORT=3000
EXPOSE ${PORT}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:${PORT}/health', (r) => {if(r.statusCode !== 200) throw new Error()})"

# Run the application
CMD ["node", "src/server.js"]