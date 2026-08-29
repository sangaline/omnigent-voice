FROM debian:bookworm-slim AS models

RUN apt-get update \
    && apt-get install -y --no-install-recommends bzip2 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /models

RUN set -eu; \
    curl -fsSL --retry 3 \
      -o /tmp/asr.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25.tar.bz2; \
    echo '78e2b79fcf7271553a74402a76b771b09ea40117a39566a79f52235b23db6358  /tmp/asr.tar.bz2' | sha256sum -c -; \
    tar -xjf /tmp/asr.tar.bz2; \
    mv sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25 asr; \
    rm /tmp/asr.tar.bz2

RUN set -eu; \
    curl -fsSL --retry 3 \
      -o /tmp/tts.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium.tar.bz2; \
    echo '9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e  /tmp/tts.tar.bz2' | sha256sum -c -; \
    tar -xjf /tmp/tts.tar.bz2; \
    mv vits-piper-en_US-lessac-medium tts; \
    curl -fsSL --retry 3 \
      -o /tmp/espeak-ng-data.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.bz2; \
    echo '4135ccf82e1f40613491c0874d4945ae9e9c7840933d8e25a6f9e003d9ebf533  /tmp/espeak-ng-data.tar.bz2' | sha256sum -c -; \
    tar -xjf /tmp/espeak-ng-data.tar.bz2 -C tts; \
    rm /tmp/tts.tar.bz2 /tmp/espeak-ng-data.tar.bz2

FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build \
    && find dist -type f -name '*.test.js' -delete \
    && rm dist/eval.js dist/evaluation.js dist/replay.js dist/scenario-eval.js

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
