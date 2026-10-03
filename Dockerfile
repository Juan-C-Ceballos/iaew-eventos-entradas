# Imagen compartida por los servicios api, worker y db-init (cambia solo el comando).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY migrate-mongo-config.js ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY docs ./docs

USER node
EXPOSE 3000
CMD ["node", "src/app.js"]
