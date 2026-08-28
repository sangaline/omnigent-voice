FROM debian:bookworm-slim AS models

RUN apt-get update \
    && apt-get install -y --no-install-recommends bzip2 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /models

RUN set -eu; \
    curl -fsSL --retry 3 \
      -o /tmp/asr.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8.tar.bz2; \
    echo '7bd33a914e93370a1ba9c2066d9e841bdcad8613fa2a00537c1ae15d851a14d8  /tmp/asr.tar.bz2' | sha256sum -c -; \
    tar -xjf /tmp/asr.tar.bz2; \
    mv sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8 asr; \
    rm /tmp/asr.tar.bz2

RUN set -eu; \
    curl -fsSL --retry 3 \
      -o /tmp/tts.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2; \
    echo 'c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd  /tmp/tts.tar.bz2' | sha256sum -c -; \
    tar -xjf /tmp/tts.tar.bz2; \
    mv kokoro-int8-en-v0_19 tts; \
    rm /tmp/tts.tar.bz2

FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build \
    && find dist -type f -name '*.test.js' -delete

FROM node:24-bookworm-slim AS dependencies

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    SHERPA_ASR_MODEL_DIR=/opt/models/asr \
    SHERPA_TTS_MODEL_DIR=/opt/models/tts

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY --from=models /models/asr /opt/models/asr
COPY --from=models /models/tts /opt/models/tts

USER node
CMD ["node", "dist/index.js"]

