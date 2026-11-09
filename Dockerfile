# Make It Right: the API and the screens, PayPal sandbox only. Built by the host from the GitHub repo.
# The ECR Public mirror of the official Node image avoids Docker Hub's anonymous pull limit on shared builders.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# Infisical CLI, pinned and checksum-verified: tools/docker-entrypoint.sh hands the vault's secrets to the app with `infisical run`.
ARG INFISICAL_VERSION=0.43.145
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) sha="36732e9c108feb3916eabd5be35db7a56431c383b766a6c3b1afa05cb27696ae" ;; \
      arm64) sha="9b559ed2bd639c59999eb181270aca975554ca45fcdf2eaf118d53a8fce4b98c" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/infisical.deb "https://github.com/Infisical/cli/releases/download/v${INFISICAL_VERSION}/infisical_${INFISICAL_VERSION}_linux_${arch}.deb"; \
    echo "${sha}  /tmp/infisical.deb" | sha256sum -c -; \
    apt-get install -y --no-install-recommends /tmp/infisical.deb; \
    rm -f /tmp/infisical.deb; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    infisical --version; \
    command -v setpriv

ENV NODE_ENV=production \
    PORT=8080 \
    MIR_DATA_DIR=/data \
    SECRETS_SOURCE=infisical

WORKDIR /app
# tsx is a runtime dependency: the TypeScript sources run as they are, with no build step
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY demo ./demo
COPY --chmod=0755 tools/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data

EXPOSE 8080
# No USER line: the entrypoint starts as root only to hand the mounted data directory to user `node`, then runs the app as `node`.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/server.ts"]
