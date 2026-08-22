# Transcrições locais (yt-txt)

Aplicativo macOS para baixar vídeos do **YouTube**, arquivos públicos do **Google Drive**, **links da Web** ou selecionar vídeos e faixas de áudio locais do próprio Mac e gerar uma transcrição em português inteiramente local e privada via Whisper.

Cada lote cria uma pasta em `~/Downloads/Transcrições/<data-hora>/`, contendo as mídias baixadas, `audio.mp3` e `transcricao.txt`.

## Recursos

- **Fontes de Mídia Suportadas**:
  - Links do YouTube (`youtube.com`, `youtu.be`).
  - Arquivos compartilhados do Google Drive.
  - Links de vídeo/áudio da Web suportados pelo `yt-dlp` (Vimeo, TikTok, etc.).
  - Arquivos locais no Mac: MP4, MOV, M4V, MKV, WebM, AVI, MP3, M4A, WAV, AAC, OGG, FLAC, AIFF e OPUS.
- **Gerenciador de Modelos In-App**: Baixe e alterne com 1 clique modelos GGML oficiais do Hugging Face (`tiny`, `base`, `small`, `medium`, `large-v3-turbo`, `large-v3`) com progresso em tempo real e métricas de RAM/velocidade.
- **Múltiplos Formatos de Exportação**: Geração simultânea de `.txt` (texto plano), `.srt` (legendas com timestamps), `.vtt` (WebVTT), `.json` e `.md` (Markdown formatado).
- **Progresso Granular em Tempo Real**: Barra de progresso animada com percentual contínuo do download via `yt-dlp` e da transcrição via `whisper.cpp`.
- **Histórico Persistente com Busca**: Armazenamento local de todas as transcrições, contador de palavras e barra de pesquisa instantânea para localizar trechos transcritos.
- **Visualizador Multi-Formato**: Leia, alterne entre abas de formatos, consulte estatísticas de palavras/caracteres e copie o texto ou legenda em 1 clique.
- **Processamento 100% Local**: Áudio e transcrições gerados no próprio computador sem envio para nuvem.
- **Integração com o Finder**: Botão direto para abrir a pasta de saída do lote ou do item.
- **Configurações Nativas**: Seletores de arquivo e pasta nativos do macOS para configurar dependências.

## Pré-requisitos de processamento

O aplicativo detecta automaticamente estes caminhos padrão (Homebrew):

- `/opt/homebrew/bin/yt-dlp`
- `/opt/homebrew/bin/ffmpeg`
- `/opt/homebrew/bin/whisper-cli`
- `~/whisper-models/ggml-medium.bin`

## Executar em desenvolvimento

```sh
npm install
npm run tauri dev
```

Para criar o app macOS (.app / .dmg):

```sh
npm run tauri build
```

O bundle será gerado em `src-tauri/target/release/bundle/macos/Transcrições locais.app`.

## Verificações

```sh
npm run build
PATH="/opt/homebrew/opt/rust/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml
```

