FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.js ./

USER node
EXPOSE 4000
CMD ["node", "server.js"]
