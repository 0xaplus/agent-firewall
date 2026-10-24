# Spend Firewall: one Bun process serving the dashboard, the REST API and the MCP endpoint.
FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production

COPY src ./src
COPY public ./public
COPY demo ./demo
COPY bench ./bench

ENV NODE_ENV=production
# Hosts like Render set PORT; the server listens on 0.0.0.0.
EXPOSE 3000
# Seeding is idempotent: on a fresh disk it adds the demo agents, otherwise it changes nothing.
CMD ["sh", "-c", "bun run src/seed.ts && exec bun run src/index.ts"]
