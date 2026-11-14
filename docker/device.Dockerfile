# Device side, sized for a Raspberry Pi 5-class board (arm64). Proves memory fit, not CPU speed.
#   docker buildx build --platform linux/arm64 -t device:arm64 -f docker/device.Dockerfile .
#   docker run --platform linux/arm64 --memory=512m --cpus=1 -p 5173:5173 -e SERVER_URL=http://host.docker.internal:8787 device:arm64
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/device apps/device
# The 3D twin imports its models from here.
COPY web-render/device-handoff/white-slider-device.glb web-render/device-handoff/dock-station.glb web-render/device-handoff/
RUN --mount=type=secret,id=ca,required=false \
  if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
  corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --filter device... --no-frozen-lockfile && pnpm --filter device build

FROM debian:bookworm-slim
# Node only to serve files; on the real board this is a kiosk browser (WPE WebKit / Cog).
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /repo/apps/device/dist ./dist
COPY docker/serve.mjs ./serve.mjs
ENV PORT=5173 SERVER_URL=http://host.docker.internal:8787 NODE_OPTIONS=--max-old-space-size=96
EXPOSE 5173
USER nobody
CMD ["node", "serve.mjs"]
