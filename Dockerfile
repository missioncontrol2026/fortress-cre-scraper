# Playwright base image includes Chromium + all OS dependencies pre-installed.
# Version pinned to match the playwright npm package we depend on.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Install curl-impersonate binary for Chrome TLS spoofing (used to defeat Akamai
# without needing to launch a real Chromium). Downloaded from official releases.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && \
    wget -qO /tmp/curl-impersonate.tar.gz \
      "https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz" && \
    tar -xzf /tmp/curl-impersonate.tar.gz -C /usr/local/bin/ && \
    rm /tmp/curl-impersonate.tar.gz && \
    /usr/local/bin/curl_chrome124 --version 2>&1 | head -1 || echo "curl-impersonate installed"

COPY package.json ./
RUN npm install --omit=optional --ignore-scripts

# Copy source
COPY . .

# Persistent-session directory for CoStar/Reonomy cookies + local storage
RUN mkdir -p /app/sessions

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
