FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV MESH_BRIDGE_STATE_DIR=/var/lib/mesh-bridge
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends udev \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --home /var/lib/mesh-bridge --create-home --shell /usr/sbin/nologin meshbridge \
  && mkdir -p /var/lib/mesh-bridge \
  && chown -R meshbridge:meshbridge /var/lib/mesh-bridge /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
USER meshbridge
CMD ["node", "dist/service.js"]
