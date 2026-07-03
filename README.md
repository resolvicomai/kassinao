# Kassinão 🎙️

Bot de gravação de voz para Discord inspirado no [Craig](https://craig.chat/) — feito para o time, em português, com as features pagas do Craig liberadas de graça.

## O que ele faz

- **Multi-track sincronizado**: uma faixa de áudio separada por pessoa, todas com a mesma linha do tempo — é só alinhar no início em qualquer editor.
- **Painel ao vivo** no chat do canal de voz: log de eventos com timestamp (quem entrou na gravação, avisos de silêncio), botão de parar e link da página.
- **Página web da gravação** com login via Discord: participantes com avatar, linha do tempo e downloads em **MP3** (multi-track), **FLAC** (lossless) e **Mix único** (todo mundo em um MP3) — processados na hora, inclusive **durante a gravação**.
- **Acesso restrito**: só quem participou da call, enxerga o canal de voz no Discord, iniciou a gravação ou administra o servidor consegue abrir a página. Link vazado não dá acesso a ninguém de fora.
- **Transcrição automática** com nome do falante e timestamps exatos (cada pessoa tem faixa própria — sem diarização por IA). Motor plugável: OpenAI, Groq, Gemini ou **comando local** (faster-whisper/whisper.cpp/Parakeet) para privacidade total. Renderizada na página + download .md/.txt + aviso no painel, tudo com o mesmo controle de acesso.
- **Notas com timestamp** (`/nota` ou botão no painel) — vão para o painel, o `info.txt`, os labels do Audacity e a transcrição.
- **Projeto Audacity**: ZIP com FLACs + `projeto.lof` (abre com tudo alinhado) + notas como labels.
- **Apelido `[GRAVANDO]`** enquanto grava (consentimento visível) e **DM para quem iniciou** com os links.
- **Auto-record**: começa a gravar sozinho quando N pessoas entram num canal configurado e para quando esvazia.
- **Comandos em pt-BR e inglês** (o idioma segue o cliente Discord de cada pessoa).
- Aviso de silêncio (5 min), parada automática por limite de horas / canal vazio / desconexão, expiração automática das gravações, recuperação pós-reinício (inclusive de transcrições interrompidas).

## Comandos

| pt-BR | inglês | o que faz |
|---|---|---|
| `/gravar [canal]` | `/record [channel]` | Começa a gravar (o seu canal de voz, ou o indicado) |
| `/parar` | `/stop` | Para a gravação e mostra o link da página |
| `/nota texto` | `/note text` | Marca uma nota no tempo atual (também pelo botão 📝 do painel) |
| `/status` | `/status` | Estado da gravação atual |
| `/gravacoes` | `/recordings` | Últimas 5 gravações do servidor, com links |
| `/autorecord ligar/desligar/ver` | `/autorecord on/off/view` | Gravação automática por canal |

Qualquer membro pode gravar e parar. Configurar o `/autorecord` (ligar/desligar) exige a permissão **Gerenciar Servidor**. Apagar uma gravação (pela página) é restrito a quem iniciou ou a quem tem "Gerenciar Servidor".

A página web é bilíngue (pt-BR/inglês, pelo idioma do navegador) e, em gravações ao vivo, se atualiza sozinha a cada 30s.

## Setup — Discord Developer Portal

1. Acesse <https://discord.com/developers/applications> → **New Application** → nome `Kassinão`.
2. Em **General Information**: copie o **Application ID** → `APPLICATION_ID`.
3. Em **Bot**:
   - **Reset Token** → copie o token → `DISCORD_TOKEN`;
   - Nenhuma *privileged intent* é necessária.
4. Em **OAuth2**:
   - copie o **Client Secret** → `DISCORD_CLIENT_SECRET`;
   - em **Redirects**, adicione `SUA_BASE_URL/auth/callback` (ex.: `http://SEU_IP:8080/auth/callback`) — sem isso o login da página de downloads falha.
5. Convide o bot para o servidor (troque `SEU_APPLICATION_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=SEU_APPLICATION_ID&scope=bot%20applications.commands&permissions=68176896
   ```

   (permissões: Ver canais, Enviar mensagens, Inserir links, Conectar, Alterar apelido — a última é para o indicador `[GRAVANDO]`)

## Rodando com Docker (produção)

```bash
cp .env.example .env   # preencha DISCORD_TOKEN, APPLICATION_ID, DISCORD_CLIENT_SECRET, BASE_URL e (opcional) GUILD_ID
docker compose up -d --build
docker compose logs -f  # deve mostrar "Kassinão online como ..."
```

- As gravações ficam em `./recordings` (montado como volume — sobrevivem a rebuilds).
- `BASE_URL` precisa ser alcançável pelo time (IP público do VPS ou domínio atrás de um proxy reverso com HTTPS). Lembre de manter o Redirect URI do OAuth em sincronia.

## Rodando local (desenvolvimento)

```bash
npm install
cp .env.example .env   # preencha as variáveis
npm run dev            # roda com reload automático
```

`GUILD_ID` preenchido faz os comandos aparecerem instantaneamente no seu servidor (sem ele, o registro global demora até 1h).

## Configurações (.env)

| Variável | Padrão | Descrição |
|---|---|---|
| `DISCORD_TOKEN` | — | Token do bot |
| `APPLICATION_ID` | — | ID da aplicação |
| `DISCORD_CLIENT_SECRET` | — | Client Secret (OAuth2 da página web) |
| `GUILD_ID` | — | Registro instantâneo de comandos nesse servidor |
| `BASE_URL` | `http://localhost:8080` | URL pública dos links e do OAuth |
| `PORT` | `8080` | Porta do servidor web |
| `RECORDINGS_DIR` | `./recordings` | Onde salvar as gravações |
| `RETENTION_DAYS` | `7` | Dias até a gravação expirar |
| `MAX_RECORDING_HOURS` | `6` | Duração máxima por gravação |
| `MP3_BITRATE` | `192k` | Bitrate dos MP3 |
| `COOKIE_SECRET` | gerado | Segredo dos cookies de sessão |
| `TRANSCRIBE_PROVIDER` | `none` | Motor de transcrição: `none`/`openai`/`groq`/`gemini`/`command` |
| `TRANSCRIBE_MODEL` | por provider | Modelo (ex.: `whisper-1`, `whisper-large-v3-turbo`, `gemini-2.0-flash`) |
| `TRANSCRIBE_LANGUAGE` | `pt` | Idioma falado nas calls |
| `TRANSCRIBE_COMMAND` | — | Comando local com `{input}`/`{output}` (provider `command`) |
| `TRANSCRIBE_TIMEOUT_FACTOR` | `5` | Watchdog do provider `command` = max(10min, duração × fator) |
| `OPENAI_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` | — | Chave do provider escolhido |
| `TZ` | `America/Sao_Paulo` | Fuso das datas (a página web usa o do navegador de quem abre) |

### Transcrição local (privacidade total)

Com `TRANSCRIBE_PROVIDER=command` o áudio nunca sai do servidor. Wrapper pronto para faster-whisper em [scripts/transcribe-local.py](scripts/transcribe-local.py):

```bash
pip install faster-whisper
# .env:
TRANSCRIBE_PROVIDER=command
TRANSCRIBE_COMMAND=python3 ./scripts/transcribe-local.py {input} {output}
```

**No Docker**, a transcrição local exige Python + faster-whisper na imagem — construa com o build-arg:

```bash
docker compose build --build-arg LOCAL_TRANSCRIBE=1   # (ou descomente args em docker-compose.yml)
docker compose up -d
```

Qualquer comando serve (whisper.cpp, Parakeet…), desde que escreva em `{output}` um JSON `[{"start":s,"end":s,"text":"..."}]`. Modelo local grande e lento? Aumente `TRANSCRIBE_TIMEOUT_FACTOR`.

Custo de referência dos providers online (por hora de fala, por faixa): OpenAI ~US$0,36; Groq ~US$0,02; Gemini Flash ~centavos. Lembre: providers online recebem o áudio das suas reuniões.

## Como funciona por dentro

- O bot recebe os pacotes Opus de cada falante via `@discordjs/voice`, decodifica para PCM e alimenta **um ffmpeg por falante** que encoda **FLAC contínuo** em disco (master lossless). Os intervalos sem fala viram silêncio digital — que em FLAC ocupa quase nada — mantendo todas as faixas na mesma linha do tempo.
- Os downloads (MP3/FLAC/mix) são "cozinhados" sob demanda a partir dos masters, com cache para gravações finalizadas e snapshot para gravações ao vivo.
- A página web autentica com OAuth2 do Discord (escopo `identify`) e o bot verifica no próprio Discord se a pessoa participou da gravação ou enxerga o canal de voz de origem.
