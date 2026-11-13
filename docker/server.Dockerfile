# The server, for "Own VM" or "Self-hosted". Same image on our cloud.
#   docker build -t flip-server -f docker/server.Dockerfile .
#   docker run -p 8787:8787 -v flip-data:/data -e ANTHROPIC_API_KEY=... -e PC_AGENTS="MacBook=ws://100.x.y.z:7077" -e PC_AGENT_TOKEN=... flip-server
FROM node:22-bookworm-slim
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN pnpm install --filter server... --no-frozen-lockfile
ENV PORT=8787 DATA_DIR=/data HOSTING=self
VOLUME /data
EXPOSE 8787
WORKDIR /repo/apps/server
CMD ["npx", "tsx", "src/index.ts"]
