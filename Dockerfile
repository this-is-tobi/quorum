ARG BUN_IMAGE=docker.io/oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:cb87acc574abe719b6e5c547384defa2f7b1f24af9605d3f618cf852495d8be2

# Build stage - compiles the binary for the platform it runs on, so the CD builds each architecture
# on a native runner. Only what the compile reads is copied in, and no lifecycle script runs
FROM ${BUN_IMAGE} AS build

WORKDIR /app
COPY package.json bun.lock ./
# Every locked dependency: the binary bundles the MCP SDK, a development dependency that a production
# install leaves out, and holds only what the code imports, so the development tools never reach it
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile --ignore-scripts
COPY src ./src
# The compile script holds the flags that keep the binary from reading a .env or a bunfig.toml
RUN bun run compile


# Final stage - the binary alone on a distroless base: no shell, no package manager, a non-root user
FROM ${RUNTIME_IMAGE}

COPY --from=build /app/bin/quorum /usr/local/bin/quorum
USER nonroot
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/quorum"]
