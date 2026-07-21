FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
