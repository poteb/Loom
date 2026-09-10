FROM node:24-alpine AS build
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY src/core/package.json src/core/
COPY src/server/package.json src/server/
RUN pnpm install --frozen-lockfile
COPY src/core src/core
COPY src/server src/server
RUN pnpm --filter @loom/core build && pnpm --filter @loom/server build
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
ENV NODE_ENV=production
EXPOSE 3000
WORKDIR /app/src/server
CMD ["node", "dist/main.js"]
