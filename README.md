# Transcrições locais

Aplicativo macOS para baixar vídeos públicos do Google Drive ou selecionar vídeos/faixas de áudio do próprio Mac e gerar uma transcrição em português inteiramente local. Cada lote cria uma pasta em `~/Downloads/Transcrições/<data-hora>/`, contendo o arquivo original, `audio.mp3` e `transcricao.txt`.

## Pré-requisitos de processamento

O aplicativo detecta automaticamente estes caminhos, que também podem ser alterados pela tela **Configurações**:

- `/opt/homebrew/bin/yt-dlp`
- `/opt/homebrew/bin/ffmpeg`
- `/opt/homebrew/bin/whisper-cli`
- `~/whisper-models/ggml-medium.bin`

Os links precisam ser HTTPS e apontar para arquivos do Google Drive compartilhados publicamente. Links de pastas e arquivos que exigem login não são aceitos na primeira versão. Arquivos locais aceitos: MP4, MOV, M4V, MKV, WebM, AVI, MP3, M4A, WAV, AAC, OGG, FLAC, AIFF e OPUS.

## Executar em desenvolvimento

```sh
npm install
npm run tauri dev
```

Para criar o app macOS:

```sh
npm run tauri build
```

O bundle será gerado em `src-tauri/target/release/bundle/macos/Transcrições locais.app`.

## Verificações

```sh
npm run build
PATH="/opt/homebrew/opt/rust/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml
```
