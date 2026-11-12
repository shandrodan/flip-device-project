# docker

Proves the device side fits a Raspberry Pi 5-class board.

```bash
docker buildx build --platform linux/arm64 -t device:arm64 -f docker/device.Dockerfile .
docker run --platform linux/arm64 --memory=512m --cpus=1 -p 5173:5173 device:arm64
docker stats
```

Say on stage: "fits Pi 5 memory limits". Don't claim Pi speed: emulated arm64 on a laptop says nothing about CPU performance.

Dockerfile: TBD (Debian slim + built device app + a static server).
