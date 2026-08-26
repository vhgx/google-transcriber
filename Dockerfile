# ==============================================================================
# ESTÁGIO 1: Compilação do Frontend React (Node.js)
# ==============================================================================
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src

RUN npm run build

# ==============================================================================
# ESTÁGIO 2: Compilação do whisper.cpp e do Servidor Rust (Axum)
# ==============================================================================
FROM rust:1-bookworm AS backend-builder
WORKDIR /app

# Instalar ferramentas de compilação para o whisper.cpp (incluindo Clang para suporte ARM64 NEON / x86_64)
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    git \
    build-essential \
    clang \
    llvm \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Compilar whisper-cli diretamente do repositório oficial com Clang (estático e autocontido)
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /tmp/whisper.cpp \
    && cd /tmp/whisper.cpp \
    && CC=clang CXX=clang++ cmake -B build \
       -DCMAKE_BUILD_TYPE=Release \
       -DBUILD_SHARED_LIBS=OFF \
       -DWHISPER_BUILD_TESTS=OFF \
       -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build --config Release -j $(nproc) --target whisper-cli \
    && cp build/bin/whisper-cli /tmp/whisper-cli \
    && rm -rf /tmp/whisper.cpp

# Compilar o servidor Rust
COPY src-server ./src-server
WORKDIR /app/src-server
RUN cargo build --release

# ==============================================================================
# ESTÁGIO 3: Imagem Final de Execução (Runtime)
# ==============================================================================
FROM debian:bookworm-slim
WORKDIR /app

# Instalar dependências essenciais de runtime: ffmpeg, python3, curl, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Instalar binário oficial do yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Copiar os binários compilados
COPY --from=backend-builder /tmp/whisper-cli /usr/local/bin/whisper-cli
COPY --from=backend-builder /app/src-server/target/release/yt-txt-server /usr/local/bin/yt-txt-server

# Copiar assets estáticos compilados do frontend
COPY --from=frontend-builder /app/dist /app/dist

# Criar pastas para volumes de dados persistentes
RUN mkdir -p /data/models /data/downloads /data/config /data/uploads

# Variáveis de ambiente padrão
ENV PORT=3000 \
    DATA_DIR=/data \
    DIST_DIR=/app/dist \
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    WHISPER_PATH=/usr/local/bin/whisper-cli \
    MODEL_PATH=/data/models/ggml-medium.bin \
    OUTPUT_DIR=/data/downloads \
    OLLAMA_ENDPOINT=http://host.docker.internal:11434

EXPOSE 3000

VOLUME ["/data"]

CMD ["/usr/local/bin/yt-txt-server"]
