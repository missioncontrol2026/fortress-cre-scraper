# Playwright base image includes Chromium + all OS dependencies pre-installed.
# Version pinned to match the playwright npm package we depend on.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Copy manifest and install deps
# Install koffi + impers first with postinstall enabled (koffi ships native prebuilt binaries)
# Then install the rest without postinstall (skips playwright's Chromium download since the base image has it)
COPY package.json ./
RUN npm install koffi impers --no-save
RUN npm install --omit=optional --ignore-scripts

# Copy source
COPY . .

# Persistent-session directory for CoStar/Reonomy cookies + local storage
RUN mkdir -p /app/sessions

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
