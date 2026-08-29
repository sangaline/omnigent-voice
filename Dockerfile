FROM debian:trixie-slim AS models

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

RUN set -eu; \
    mkdir -p endpoint; \
    curl -fsSL --retry 3 \
      -o endpoint/silero_vad.onnx \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx; \
    echo '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6  endpoint/silero_vad.onnx' | sha256sum -c -; \
    curl -fsSL --retry 3 \
      -o endpoint/smart-turn-v3.2-cpu.onnx \
      https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx; \
    echo '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f  endpoint/smart-turn-v3.2-cpu.onnx' | sha256sum -c -

FROM debian:trixie-slim AS native

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential ca-certificates cmake git glslc libsentencepiece-dev \
      libvulkan-dev ninja-build \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --filter=blob:none https://github.com/Codes4Fun/ggml.git ggml \
    && git -C ggml checkout 8cf09e9cd3c227ecb42aefc544c820b6c63a28f3 \
    && git clone --filter=blob:none https://github.com/Codes4Fun/moshi.cpp.git moshi \
    && git -C moshi checkout f1fabbd14a506076d4d0a9755811598220ee9e13

COPY native/moshi-kame.patch /tmp/moshi-kame.patch
RUN git -C /src/moshi apply /tmp/moshi-kame.patch \
    && cmake -S /src/ggml -B /src/ggml/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_BACKEND_DL=ON \
      -DGGML_CPU=ON \
      -DGGML_CPU_ALL_VARIANTS=OFF \
      -DGGML_NATIVE=OFF \
      -DGGML_VULKAN=ON \
      -DVulkan_GLSLC_EXECUTABLE=/usr/bin/glslc \
    && cmake --build /src/ggml/build --parallel \
    && cmake -S /src/moshi -B /src/moshi/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DMOSHI_BUILD_TOOLS=OFF \
      -DGGML_INCLUDE_DIR=/src/ggml/include \
      -DGGML_LIBRARY_DIR=/src/ggml/build/src \
      -DSentencePiece_INCLUDE_DIR=/usr/include \
      -DSentencePiece_LIBRARY_DIR=/usr/lib/x86_64-linux-gnu \
    && cmake --build /src/moshi/build --parallel

COPY native/kame_bridge.cpp /src/kame_bridge.cpp
COPY native/kame_quantize.cpp /src/kame_quantize.cpp
RUN c++ -std=c++20 -O3 /src/kame_bridge.cpp \
      -I/src/moshi/include -I/src/ggml/include \
      -L/src/moshi/build/bin -lmoshi \
      -L/src/ggml/build/src -lggml -lggml-base \
      -lsentencepiece \
      -Wl,-rpath,'$ORIGIN' \
      -o /src/kame-bridge \
    && c++ -std=c++20 -O3 /src/kame_quantize.cpp \
      -I/src/moshi/include -I/src/ggml/include \
      -L/src/moshi/build/bin -lmoshi \
      -L/src/ggml/build/src -lggml -lggml-base \
      -lsentencepiece \
      -Wl,-rpath,'$ORIGIN' \
      -o /src/kame-quantize \
    && install -d /out \
    && install -m 0755 /src/kame-bridge /out/kame-bridge \
    && install -m 0755 /src/kame-quantize /out/kame-quantize \
    && cp -a /src/moshi/build/bin/libmoshi.so /out/ \
    && cp -a /src/ggml/build/src/libggml.so* /src/ggml/build/src/libggml-base.so* /out/ \
    && cp -a /src/ggml/build/bin/libggml-cpu.so /src/ggml/build/bin/libggml-vulkan.so /out/

FROM node:24-trixie-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build \
    && find dist -type f -name '*.test.js' -delete \
    && rm dist/eval.js dist/evaluation.js dist/replay.js dist/scenario-eval.js

FROM node:24-trixie-slim AS dependencies

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM python:3.13-slim-trixie AS endpoint-python

RUN pip install --no-cache-dir --target /opt/smart-turn-python \
      numpy==2.5.2 onnxruntime==1.29.0

FROM node:24-trixie-slim AS pocket-python

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/pocket-tts \
    && /opt/pocket-tts/bin/pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.13.0+cpu \
    && /opt/pocket-tts/bin/pip install --no-cache-dir pocket-tts==3.0.2

ENV HF_HOME=/opt/pocket-cache \
    POCKET_TTS_NO_BEARTYPE=1

RUN /opt/pocket-tts/bin/python -c \
      'from pocket_tts import TTSModel; model = TTSModel.load_model(quantize=True); model.get_state_for_audio_prompt("alba")' \
    && rm -rf \
      /opt/pocket-tts/lib/python*/site-packages/torch/include \
      /opt/pocket-tts/lib/python*/site-packages/torch/test \
      /opt/pocket-tts/lib/python*/site-packages/pip \
      /opt/pocket-tts/lib/python*/site-packages/pip-*.dist-info \
      /opt/pocket-tts/lib/python*/site-packages/setuptools \
      /opt/pocket-tts/lib/python*/site-packages/setuptools-*.dist-info \
    && find /opt/pocket-tts/lib/python*/site-packages/torch/bin \
      -mindepth 1 ! -name torch_shm_manager -delete \
    && find /opt/pocket-tts -type d -name __pycache__ -prune -exec rm -rf '{}' +

FROM node:24-trixie-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libgomp1 libsentencepiece0 libvulkan1 mesa-vulkan-drivers \
      python3 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    SHERPA_ASR_MODEL_DIR=/opt/models/asr \
    SHERPA_TTS_MODEL_DIR=/opt/models/tts \
    KAME_BRIDGE_PATH=/opt/omnigent-voice/bin/kame-bridge \
    POCKET_TTS_PYTHON=/opt/pocket-tts/bin/python \
    POCKET_TTS_BRIDGE_PATH=/opt/omnigent-voice/pocket-tts/bridge.py \
    HF_HOME=/opt/pocket-cache \
    HF_HUB_OFFLINE=1 \
    POCKET_TTS_NO_BEARTYPE=1 \
    SMART_TURN_BRIDGE_PATH=/opt/omnigent-voice/smart-turn/bridge.py \
    PYTHONPATH=/opt/smart-turn-python \
    LD_LIBRARY_PATH=/opt/omnigent-voice/bin

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=endpoint-python /opt/smart-turn-python /opt/smart-turn-python
COPY --from=pocket-python /opt/pocket-tts /opt/pocket-tts
COPY --from=pocket-python /opt/pocket-cache /opt/pocket-cache
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY --from=models /models/asr /opt/models/asr
COPY --from=models /models/tts /opt/models/tts
COPY --from=models /models/endpoint /opt/models/endpoint
COPY --from=native /out/ /opt/omnigent-voice/bin/
COPY runtime/smart-turn /opt/omnigent-voice/smart-turn
COPY runtime/pocket-tts /opt/omnigent-voice/pocket-tts

USER node
CMD ["node", "dist/index.js"]
