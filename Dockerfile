FROM node:20-slim
RUN apt-get update && apt-get install -y chromium libnss3 libxss1 libasound2 libatk-bridge2.0-0 libgtk-3-0 dumb-init wget && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm tsx
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_ARGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage"
RUN pnpm install --no-frozen-lockfile
ENV NODE_ENV=production
EXPOSE 8080
CMD ["tsx", "packages/scraper/src/server.ts"]
