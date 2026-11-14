# The server, for "Own VM" or "Self-hosted". Same image on our cloud.
#   docker build -t flip-server -f docker/server.Dockerfile .
#   docker run -p 8787:8787 -v flip-data:/data -e OPENROUTER_API_KEY=... -e PC_AGENTS="MacBook=ws://100.x.y.z:7077" -e PC_AGENT_TOKEN=... flip-server
# Behind a TLS-inspecting proxy, pass its CA: docker build --secret id=ca,src=/path/ca.crt ...
# It runs the agent engine (OpenCode, ADR 0032) and, with BUILD_HOST=server, the Build project (ADR 0033),
# so it uses the full Node image: git, curl and a compiler for npm packages that need one are already in it.
FROM node:22-bookworm
WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN --mount=type=secret,id=ca,required=false \
  if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
  corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --filter server... --no-frozen-lockfile
# Headless Chromium for build_screenshot. Debian's mirrors over https: a TLS-only proxy refuses plain http.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN --mount=type=secret,id=ca,required=false \
  if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; echo 'Acquire::https::CAInfo "/run/secrets/ca";' > /etc/apt/apt.conf.d/99flip-ca; fi; \
  sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
  cd apps/server && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium; \
  rm -f /etc/apt/apt.conf.d/99flip-ca; rm -rf /var/lib/apt/lists/*
ENV PORT=8787 DATA_DIR=/data HOSTING=self
VOLUME /data
EXPOSE 8787
WORKDIR /repo/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
