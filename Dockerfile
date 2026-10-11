# The arena image: what every Fly machine of the app swu-arena runs (fly.toml). Today that is the arena window
# (bot/arena/window.js, ARENA_MODE=window); the whole arena moves into this image in phase B of the hosting plan.
# Built from the repo by .github/workflows/deploy-arena.yml on Fly's builders, never from a thread's container.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY studio/package.json studio/package-lock.json studio/
RUN npm --prefix studio ci --no-audit --no-fund
COPY . .
# the viewer kit, and the app as a shell page that loads its data from the window's API
RUN npm --prefix studio run build:kit && node app/build.mjs --public --shell --data /nonexistent

FROM node:22-bookworm-slim
ENV NODE_ENV=production ARENA_MODE=window WINDOW_HOME=/data/window PORT=8080
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/bot/arena bot/arena
COPY --from=build /src/app/src app/src
COPY --from=build /src/app/dist/public.html app/dist/public.html
COPY --from=build /src/meta/atlas-kit.js meta/atlas-kit.js
COPY --from=build /src/dashboard/site dashboard/site
COPY --from=build /src/studio/dist-kit/swu-viewer-kit.js studio/dist-kit/swu-viewer-kit.js
EXPOSE 8080
CMD ["node", "bot/arena/server.js", "--host", "0.0.0.0", "--port", "8080"]
