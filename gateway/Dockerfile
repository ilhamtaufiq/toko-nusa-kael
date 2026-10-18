# Tahap 1: ambil merchantid dari commit yang sudah diaudit lalu build di dalam image.
# Tidak memakai paket npm, karena isinya belum tentu sama dengan kode yang diaudit.
FROM node:20-alpine AS build
RUN apk add --no-cache git
ARG MERCHANTID_REF=1fa55b3e1024861ef74968f9cdb1bb1bfb899fea
RUN git clone https://github.com/alhifnywahid/merchantid.git /src \
 && cd /src \
 && git checkout "$MERCHANTID_REF" \
 && npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

# Tahap 2: image runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=build /src /app/node_modules/merchantid
COPY package.json server.mjs store.mjs login.mjs ./

# Sesi dan data pembayaran disimpan di volume, bukan di image
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=3100
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3100/health || exit 1

CMD ["node", "server.mjs"]
