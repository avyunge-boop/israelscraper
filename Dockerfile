FROM node:20-slim
RUN apt-get update && apt-get install -y \
  chromium \
  libasound2 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnss3 \
  libpangocairo-1.0-0 \
  libxcomposite1 \
  libxdamage1 \
  libxkbcommon0 \
  libxrandr2 \
  libxss1 \
  dumb-init \
  wget \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm tsx
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
RUN pnpm install --no-frozen-lockfile
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
EXPOSE 8080
CMD ["tsx", "packages/scraper/src/server.ts"]
