# Transcrições locais (yt-txt)

Aplicativo macOS para baixar vídeos do **YouTube**, arquivos públicos do **Google Drive**, **links da Web** ou selecionar vídeos e faixas de áudio locais do próprio Mac e gerar uma transcrição em português inteiramente local e privada via Whisper.

Cada lote cria uma pasta em `~/Downloads/Transcrições/<data-hora>/`, contendo as mídias baixadas, `audio.mp3` e `transcricao.txt`.

## Recursos

- **Fontes de Mídia Suportadas**:
  - Links do YouTube (`youtube.com`, `youtu.be`).
  - Arquivos compartilhados do Google Drive.
  - Links de vídeo/áudio da Web suportados pelo `yt-dlp` (Vimeo, TikTok, etc.).
  - Arquivos locais no Mac: MP4, MOV, M4V, MKV, WebM, AVI, MP3, M4A, WAV, AAC, OGG, FLAC, AIFF e OPUS.
  - **Gravação Direta**: Grave notas de voz ou reuniões pelo microfone do Mac com visualizador de ondas sonoras em tempo real.
  - **Drag & Drop**: Arraste e solte vídeos, áudios ou links diretamente na janela do aplicativo.
- **Inteligência Artificial & Pós-processamento (Fase 4)**:
  - **Provedores Suportados**:
    - **Local & 100% Privado**: Integração nativa com **Ollama** (`http://127.0.0.1:11434`) com detecção automática dos modelos instalados no Mac (`llama3.2`, `qwen2.5`, `mistral`, `deepseek-r1`, etc.).
    - **Nuvem (Opcional)**: **Google Gemini** (`gemini-3.7-flash`, `gemini-3.1-pro-preview`, `gemini-2.5-flash`), **OpenAI** (`gpt-4o-mini`, `gpt-4o`) e **Groq** (`llama-3.3-70b-versatile`).
  - **Templates Prontos de 1 Clique**:
    - 📝 **Resumo Executivo**: Visão geral, ideias centrais e conclusões.
    - 🎯 **Plano de Ação & Tarefas**: Decisões tomadas, lista de tarefas acionáveis e prazos citados.
    - 📑 **Capítulos do YouTube**: Minutagem precisa com timestamps (`00:00 Introdução...`) gerada a partir dos timestamps do Whisper.
    - 🧹 **Transcrição Limpa / Artigo**: Converte a fala espontânea em texto editorial polido sem hesitações ("humm", "tipo", repetições).
  - **💬 Pergunte ao Áudio (Chat Interativo)**: Converse diretamente com a transcrição para tirar dúvidas ou fazer perguntas livres sobre o conteúdo.
  - **Exportação Automática**: Salvamento de relatórios em Markdown (`resumo.md`, `capitulos.md`, `tarefas.md`) na pasta do lote.
- **Player de Áudio Sincronizado**: Reproduza o áudio local com sincronização em tempo real de timestamps do Whisper, destaque automático do trecho falado e navegação clicável (clique em qualquer linha para saltar o áudio).
- **Editor de Transcrições Integrado**: Corrija termos e pontuações diretamente na interface com salvamento em disco (`.txt`, `.srt`, `.md`) e sincronização no histórico.
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

## 🐳 Executar via Docker (Modo Web)

Você pode rodar toda a aplicação conteinerizada no Docker (com `ffmpeg`, `yt-dlp` e `whisper-cli` embutidos):

```sh
docker compose up -d --build
```

Acesse no navegador: **`http://localhost:3000`**

### Volumes e Persistência:
- `./data/models`: armazena os modelos GGML do Whisper baixados.
- `./data/downloads`: armazena as mídias, áudios e transcrições geradas.
- `./data/config`: armazena as preferências e o histórico.

---

## 🖥️ Executar Servidor Web Localmente (Sem Docker)

```sh
npm run build
npm run server
```

---

## 🍎 Executar como App Desktop macOS (Tauri)

```sh
npm install
npm run tauri dev
```

Para gerar o instalador macOS (.app / .dmg):

```sh
npm run tauri build
```

O bundle será gerado em `src-tauri/target/release/bundle/macos/Transcrições locais.app`.

## Verificações

```sh
npm run build
PATH="/opt/homebrew/opt/rust/bin:$PATH" cargo check --manifest-path src-server/Cargo.toml
PATH="/opt/homebrew/opt/rust/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml
```

