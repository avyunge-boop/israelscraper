FROM node:20-slim
RUN apt-get update && apt-get install -y \
  ca-certificates \
  wget \
  gnupg \
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
  && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  && apt-get install -y /tmp/chrome.deb \
  && rm -f /tmp/chrome.deb \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm tsx
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV BUS_ALERTS_CHROME_EXECUTABLE=/usr/bin/google-chrome-stable
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_ARGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage"
RUN pnpm install --no-frozen-lockfile
ENV NODE_ENV=production
EXPOSE 8080
CMD ["tsx", "packages/scraper/src/server.ts"]
