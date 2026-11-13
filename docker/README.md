# docker

Proves the device side fits a Raspberry Pi 5-class board.

```bash
docker buildx build --platform linux/arm64 -t device:arm64 -f docker/device.Dockerfile .
docker run --platform linux/arm64 --memory=512m --cpus=1 -p 5173:5173 -e SERVER_URL=http://host.docker.internal:8787 device:arm64
docker stats
```

The image is Debian slim with the built Device app and `serve.mjs` (static files plus a `/ws` pass-through to the server). Measured outside Docker, the serving process uses about 60 MB RSS. The Device bundle is about 73 KB gzipped.

Say on stage: "fits Pi 5 memory limits". Don't claim Pi speed: emulated arm64 on a laptop says nothing about CPU performance.

Also here:
- `server.Dockerfile`: the server, for Own VM or Self-hosted.
- `compose.yml`: server + device on one box (`docker compose -f docker/compose.yml up --build`).
