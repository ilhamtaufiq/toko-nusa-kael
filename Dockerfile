# --- 1) Build frontend Astro ---
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- 2) Build backend Rust (musl, binary statis) ---
FROM rust:1-alpine AS api
RUN apk add --no-cache musl-dev
WORKDIR /api
COPY api/Cargo.toml api/Cargo.lock ./
# cache dependensi
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY api/src ./src
RUN touch src/main.rs && cargo build --release

# --- 3) Image akhir ---
FROM alpine:3.20
RUN adduser -D -u 10001 app
COPY --from=api /api/target/release/nusa-kael-api /usr/local/bin/nusa-kael-api
COPY --from=web /web/dist /app/dist
ENV BIND=0.0.0.0:8080 \
    STATIC_DIR=/app/dist
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["nusa-kael-api"]
