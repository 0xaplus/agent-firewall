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
# No demo data: a deploy starts empty. Run `bun run seed` locally for the example agents.
CMD ["bun", "run", "src/index.ts"]
