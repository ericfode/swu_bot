# The arena image: what every Fly machine of the app swu-arena runs (fly.toml). Today that is the arena window
# (bot/arena/window.js, ARENA_MODE=window); the whole arena moves into this image in phase B of the hosting plan.
# Built from the repo by .github/workflows/deploy-arena.yml on Fly's builders, never from a thread's container.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY . .
# the app as a shell page that loads its data from the window's API, with the viewer kit embedded: Holotable's kit,
# committed prebuilt in vendor/holotable (vendor/README.md), so nothing is installed or built for it here
RUN node app/build.mjs --public --shell --data /nonexistent

FROM node:22-bookworm-slim
# cwebp: the window makes the CDN's card art (~270 KB a card) into WebPs of ~70 KB for /play and /tables (bot/arena/art.js)
RUN apt-get update && apt-get install -y --no-install-recommends webp && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production ARENA_MODE=window WINDOW_HOME=/data/window PORT=8080
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/bot/arena bot/arena
# the open tables (bot/arena/tables.js) read deck lists in the arena's form and offer the tournament lists
COPY --from=build /src/bot/decklists.js bot/decklists.js
COPY --from=build /src/bot/decks/ash-meta-2026-09.json bot/decks/ash-meta-2026-09.json
COPY --from=build /src/app/src app/src
COPY --from=build /src/app/dist/public.html app/dist/public.html
COPY --from=build /src/meta/atlas-kit.js meta/atlas-kit.js
COPY --from=build /src/dashboard/site dashboard/site
COPY --from=build /src/vendor/holotable/swu-viewer-kit.js /src/vendor/holotable/swu-viewer-kit.licenses.txt vendor/holotable/
# the bot protocol, which the window's arena_guide tool hands to people building bots
COPY --from=build /src/spec/protocol.md spec/protocol.md
EXPOSE 8080
CMD ["node", "bot/arena/server.js", "--host", "0.0.0.0", "--port", "8080"]
