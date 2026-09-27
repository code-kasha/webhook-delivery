ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@10.17.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS test
# The HTTPS tests generate throwaway certificates with the OpenSSL CLI.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY . .
CMD ["pnpm", "test"]

FROM dependencies AS build
COPY tsconfig*.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
