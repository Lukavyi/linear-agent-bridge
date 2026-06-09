# Builds the Linear bridge and runs it as a standalone service.
#
# @Clawd runs this codebase as an OpenClaw plugin; the @Hermes deployment runs
# this image directly (BACKEND=hermes), with no OpenClaw to host it. The package
# has no runtime dependencies — only Node built-ins and global fetch — so the
# runtime stage ships just the compiled dist/.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY index.ts server.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
# Railway injects PORT; the server defaults to 8080 when unset.
EXPOSE 8080
CMD ["node", "dist/server.js"]
