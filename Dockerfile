# syntax=docker/dockerfile:1
# ---------------------------------------------------------------- deps
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci
# npm has a long-standing bug where optional platform-specific deps are not
# installed from a lockfile generated on another platform. Tailwind v4 needs
# both of these on musl or the CSS build fails with an opaque error.
RUN npm install --no-save \
      lightningcss-linux-x64-musl@1.30.2 \
      @tailwindcss/oxide-linux-x64-musl@4.1.18

# --------------------------------------------------------------- builder
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

# ---------------------------------------------------------------- runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Migrations + the tooling to run them, so `db:migrate` works in the image.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/pg ./node_modules/pg

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
