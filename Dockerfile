ARG BUN_IMAGE=docker.io/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:cc66d222f0a7ec996b78a99fe76a969bc80b539a5016ad866c14d1949bc6d0ab

# Build stage - compiles the binary for the platform it runs on, so the CD builds each architecture
# on a native runner. Only what the compile reads is copied in, and no lifecycle script runs
FROM ${BUN_IMAGE} AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
# The compile script holds the flags that keep the binary from reading a .env or a bunfig.toml
RUN bun run compile


# Final stage - the binary alone on a distroless base: no shell, no package manager, a non-root user
FROM ${RUNTIME_IMAGE}

COPY --from=build /app/bin/quorum /usr/local/bin/quorum
USER nonroot
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/quorum"]
