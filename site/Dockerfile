# ── Stage 1: build ────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

# Astro + sharp need a few system libs in Alpine.
RUN apk add --no-cache libc6-compat vips-dev build-base python3

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY astro.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src

RUN bun run build

# ── Stage 2: serve ────────────────────────────────────────────────────────
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O- http://localhost/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
