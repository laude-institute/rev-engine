# A pull request reviewer that satisfies the ReviewBench agent contract.
#
# Credential: OPENROUTER_API_KEY, passed in at run time and never baked in.
# Egress: the host of RB_MODEL_BASE_URL (openrouter.ai by default).
# Configuration: see the RB_CONFIG_* table in README.md.
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Make Node's built-in fetch use the forward proxy named in HTTPS_PROXY.
ENV NODE_USE_ENV_PROXY=1

WORKDIR /agent
COPY package.json ./
COPY src ./src
COPY experiments/prototypes ./experiments/prototypes

# Node 24 runs TypeScript directly, so the image needs no build step.
ENTRYPOINT ["node", "/agent/src/main.ts"]
