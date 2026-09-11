FROM node:24-alpine AS build
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY src/core/package.json src/core/
COPY src/server/package.json src/server/
COPY src/client/package.json src/client/
COPY src/web/package.json src/web/
RUN pnpm install --frozen-lockfile
COPY src/core src/core
COPY src/server src/server
COPY src/client src/client
COPY src/web src/web
RUN pnpm --filter @loom/core build && pnpm --filter @loom/client build && pnpm --filter @loom/web build && pnpm --filter @loom/server build
RUN CI=true pnpm prune --prod

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/core/package.json ./src/core/package.json
COPY --from=build /app/src/core/dist ./src/core/dist
COPY --from=build /app/src/core/drizzle ./src/core/drizzle
COPY --from=build /app/src/core/node_modules ./src/core/node_modules
COPY --from=build /app/src/server/package.json ./src/server/package.json
COPY --from=build /app/src/server/dist ./src/server/dist
COPY --from=build /app/src/server/node_modules ./src/server/node_modules
COPY --from=build /app/src/web/dist ./src/web/dist
ENV NODE_ENV=production
ENV LOOM_WEB_DIST=/app/src/web/dist
# The container's port 3000 is only reachable on the Docker network (compose does not publish
# it), so binding all interfaces here is safe — unlike a host-run dev server, which defaults to
# LOOM_HOST=127.0.0.1 (see config.ts) so it isn't exposed beyond loopback.
ENV LOOM_HOST=0.0.0.0
EXPOSE 3000
WORKDIR /app/src/server
CMD ["node", "dist/main.js"]
