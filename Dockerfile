# One container: Express API + static frontend + schema file
FROM node:20-alpine
WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY backend/ ./
COPY frontend/ ./public/
COPY db/ ./db/

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

# Run as the non-root "node" user
RUN mkdir -p uploads && chown -R node:node /app
USER node

CMD ["node", "server.js"]
