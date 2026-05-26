FROM oven/bun:1 AS base

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY README.md ./

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "start"]
