# Playwright base image includes Chromium + all OS dependencies pre-installed.
# Version pinned to match the playwright npm package we depend on.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Copy manifest and install deps (skip postinstall - Chromium is already in the base image)
COPY package.json ./
RUN npm install --omit=optional --ignore-scripts

# Copy source
COPY . .

# Persistent-session directory for CoStar/Reonomy cookies + local storage
RUN mkdir -p /app/sessions

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
