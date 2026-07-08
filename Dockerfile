# Playwright base image includes Chromium + all OS dependencies pre-installed.
# Version pinned to match the playwright npm package we depend on.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Copy manifest and install deps.
# 1) First install everything --ignore-scripts (skips playwright's Chromium download since the base image has it)
# 2) Then RE-install koffi+impers with scripts enabled so koffi's native module builds/downloads properly.
COPY package.json ./
RUN npm install --omit=optional --ignore-scripts
RUN npm rebuild koffi
RUN npm install koffi impers --force

# Copy source
COPY . .

# Persistent-session directory for CoStar/Reonomy cookies + local storage
RUN mkdir -p /app/sessions

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
