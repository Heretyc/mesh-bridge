# Docker Operation

Docker support targets Node 22 LTS on `node:22-bookworm-slim`. The primary target is `linux/amd64`. `linux/arm64` should be built on arm64 hardware so `serialport` native bits can build for that ABI when a prebuild is unavailable.

## Image

Build the production image:

```bash
docker build -t mesh-bridge .
```

The Dockerfile has a builder stage that installs `python3`, `make`, and `g++`, runs `npm ci`, and builds TypeScript. The runtime stage uses the same base image, installs `udev` because `serialport` Linux enumeration invokes `udevadm info -e`, copies `node_modules` and `dist`, runs as a non-root `meshbridge` user, and sets:

```text
MESH_BRIDGE_STATE_DIR=/var/lib/mesh-bridge
```

The container command is:

```bash
node dist/service.js
```

## Production Compose

Run:

```bash
docker compose up -d
```

`docker-compose.yml` uses `restart: unless-stopped`, `env_file: .env`, no published ports, and a named volume mounted at `/var/lib/mesh-bridge`. Logs are under `/var/lib/mesh-bridge/Logs`; reply journals are under `/var/lib/mesh-bridge/journal`.

The default device mapping is:

```yaml
devices:
  - "/dev/ttyUSB0:/dev/ttyUSB0"
group_add:
  - dialout
```

Change `/dev/ttyUSB0` to the host device that contains the Meshtastic radio. If the host distribution uses `uucp` instead of `dialout`, change `group_add` to match. The bridge IPC listener remains loopback-only inside the container; do not publish a port for it.

Stop:

```bash
docker compose down
```

## config.jsonc Mount

The bridge reads `config.jsonc` from the process working directory (`/app`).
`docker-compose.yml` bind-mounts the host file read-only:

```yaml
volumes:
  - ./config.jsonc:/app/config.jsonc:ro
```

Two properties of Docker make this mount necessary:

- `env_file` injects variables into the container environment; it does not
  create any file inside the container.
- `config.jsonc` is gitignored and is therefore never baked into the image.

If the mount is absent or the host file does not exist, the bridge exits
immediately at startup with:

```
Missing required configuration file: config.jsonc
```

Create `config.jsonc` from `config.jsonc.example` on the host before running
`docker compose up -d`.

## Disposable Test Compose

Run:

```bash
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from mesh-bridge-test
docker compose -f docker-compose.test.yml down --volumes
```

The test compose file builds the same Dockerfile's builder target and runs `npm test`. It mounts no serial device, needs no `.env`, sets `MESH_BRIDGE_STATE_DIR=/tmp/mesh-bridge`, and is safe to remove after the run.
