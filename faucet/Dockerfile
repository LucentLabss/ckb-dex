FROM oven/bun:1 AS deps
WORKDIR /repo
COPY faucet/package.json faucet/bun.lock ./faucet/
RUN cd faucet && bun install --frozen-lockfile

FROM deps AS build
COPY faucet ./faucet
COPY deployment ./deployment
RUN cd faucet && bun run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"
COPY --from=build /repo/faucet/dist ./dist
COPY --from=build /repo/faucet/package.json ./
COPY --from=build /repo/faucet/node_modules ./node_modules
COPY --from=build /repo/deployment ../deployment
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 3100
CMD ["node", "dist/index.js"]