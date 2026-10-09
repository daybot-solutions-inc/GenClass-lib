# GenClass runner image (built in the cloud by `az acr build`, no local docker):
#   - node 22 + Playwright 1.63 Chromium (+ OS deps)
#   - GenClass-lib at $REF with `npm ci`, @genclass/runtime and @genclass/sim built
#   - the nightly CI scripts from infra/ci
# Uses:
#   nightly CI anywhere:  docker run --rm -v $PWD/out:/out <acr>/genclass-runner:latest            (default CMD)
#   sim generator:        docker run --rm -v /data:/data <acr>/genclass-runner:latest \
#                           bash -lc 'cd /opt/GenClass-lib/sim && node dist/gen.js --help'
# Build (from the repo root):
#   az acr build -r acrgenclass9dc31e -t genclass-runner:latest -t genclass-runner:{{.Run.ID}} -f infra/docker/Dockerfile infra
FROM node:22-bookworm

ARG REF=runtime
ENV CI=1 npm_config_fund=false npm_config_audit=false ONNXRUNTIME_NODE_INSTALL=skip \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright GENCLASS_REPO_DIR=/opt/GenClass-lib GENCLASS_BRANCH=runtime

RUN apt-get update && apt-get install -y --no-install-recommends git jq ca-certificates \
 && npx -y playwright@1.63.0 install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm/_cacache

RUN git clone --depth 50 --branch "$REF" https://github.com/daybot-solutions-inc/GenClass-lib.git /opt/GenClass-lib \
 && cd /opt/GenClass-lib && npm ci --no-audit --no-fund --loglevel=error \
 && npm run build -w @genclass/runtime && npm run build -w @genclass/sim \
 && rm -rf /root/.npm/_cacache

COPY ci/ /opt/genclass-ci/
RUN chmod +x /opt/genclass-ci/*.sh && mkdir -p /out
WORKDIR /opt/GenClass-lib
CMD ["bash", "/opt/genclass-ci/run-tests.sh", "/out"]
