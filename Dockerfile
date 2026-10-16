# Self-hosted Logbook: one Bun process, everything under /data. See docker-compose.yml.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY entry entry
COPY src src
COPY migrations migrations
COPY --from=build /app/dist dist
ENV LOGBOOK_DATA=/data HOST=0.0.0.0 PORT=8796
VOLUME /data
EXPOSE 8796
CMD ["bun", "entry/server.ts"]
