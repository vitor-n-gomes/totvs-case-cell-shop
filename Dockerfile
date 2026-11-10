FROM node:24.22.2-bookworm-slim AS base
RUN npm install --global npm@12.2.2 --ignore-scripts --no-audit --no-fund
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY nest-cli.json tsconfig.json webpack.config.cjs ./
COPY apps ./apps
COPY libs ./libs
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/apps/api/main.js"]
