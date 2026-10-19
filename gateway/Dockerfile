# Gateway pemantau transaksi GoBiz. Dependensi: tidak ada paket npm, hanya Node 20 (fetch bawaan).
# Logika login dan baca riwayat diport dari kavionn/gobiz-payment (MIT), lihat gobiz.mjs.
FROM node:20-alpine
WORKDIR /app
COPY package.json server.mjs gobiz.mjs ./

# Sesi disimpan di volume, bukan di image
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=3100
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3100/health || exit 1

CMD ["node", "server.mjs"]
