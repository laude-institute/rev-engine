# A pull request reviewer that satisfies the ReviewBench agent contract.
#
# Credential: OPENROUTER_API_KEY, passed in at run time and never baked in.
# Egress: the host of RB_MODEL_BASE_URL (openrouter.ai by default).
# With RB_CONFIG_ENGINE=claude-code the credential is a Claude Code login and
# the egress is Anthropic's API. See docs/SETTINGS.md.
# Configuration: see the RB_CONFIG_* table in README.md.
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Claude Code, for RB_CONFIG_ENGINE=claude-code. It is left out unless the build
# names an exact version, so the default image has no dependency beyond Node:
#   docker build --build-arg CLAUDE_CODE_VERSION=2.1.321 .
ARG CLAUDE_CODE_VERSION=
RUN case "$CLAUDE_CODE_VERSION" in \
      "") ;; \
      [0-9]*.[0-9]*.[0-9]*) npm install -g "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" && npm cache clean --force ;; \
      *) echo "CLAUDE_CODE_VERSION must be an exact version, such as 2.1.321" >&2; exit 1 ;; \
    esac
# Keep Claude Code at the version the build chose.
ENV DISABLE_AUTOUPDATER=1

# Make Node's built-in fetch use the forward proxy named in HTTPS_PROXY.
ENV NODE_USE_ENV_PROXY=1

WORKDIR /agent
COPY package.json ./
COPY src ./src
COPY experiments/prototypes ./experiments/prototypes

# Node 24 runs TypeScript directly, so the image needs no build step.
ENTRYPOINT ["node", "/agent/src/main.ts"]
