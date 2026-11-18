
FROM node:20-slim

# Install native deps for Baileys, sharp, and ffmpeg-based commands
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ffmpeg \
    imagemagick \
    webp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (leverages Docker layer cache)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Optional: clone a private source repo (token never persists)
ARG BOT_SOURCE_REPO=""
ARG BOT_SOURCE_BRANCH="main"
ARG BOT_SOURCE_TOKEN=""

RUN mkdir -p /app/source && \
    if [ -n "$BOT_SOURCE_REPO" ]; then \
        rm -rf /app/source && mkdir -p /app/source && \
        repo_url="$BOT_SOURCE_REPO"; \
        if [ -n "$BOT_SOURCE_TOKEN" ]; then \
            repo_url="$(printf '%s' "$BOT_SOURCE_REPO" | sed "s#https://#https://x-access-token:${BOT_SOURCE_TOKEN}@#")"; \
        fi; \
        git clone --depth 1 --branch "$BOT_SOURCE_BRANCH" "$repo_url" /app/source && \
        rm -rf /app/source/.git; \
    fi

ENV NODE_ENV=production
ENV PORT=3000
ENV APP_MODE=bot

EXPOSE 3000

CMD ["node", "index.js"]
