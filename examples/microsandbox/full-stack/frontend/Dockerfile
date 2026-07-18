FROM node:24-bookworm-slim
ARG PNPM_VERSION=11.14.0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . ./
EXPOSE 3000
ENTRYPOINT ["pnpm", "dev"]
