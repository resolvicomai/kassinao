<div align="center">

<img src="docs/brand/kassinao-mark-64.png" width="72" height="72" alt="Logo do Kassinão">

# Kassinão

### Transforme calls do Discord em memória pesquisável.

Bot open source e self-hosted com uma faixa por pessoa, transcrição com nomes, ata, tarefas e respostas com fonte.

**🌎 Idioma:** [English](README.md) · **Português (BR)**

[![Licença: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/resolvicomai/kassinao?style=social)](https://github.com/resolvicomai/kassinao/stargazers)

<br/>

[![Ver a demo ao vivo](https://img.shields.io/badge/VER_A_DEMO_AO_VIVO-5865F2?style=for-the-badge)](https://kassinao.cloud/demo)
[![Ler a documentação](https://img.shields.io/badge/LER_A_DOCUMENTAÇÃO-313338?style=for-the-badge)](https://docs.kassinao.cloud)
[![Conector MCP](https://img.shields.io/badge/CONECTOR_MCP-313338?style=for-the-badge)](https://docs.kassinao.cloud#mcp)

<br/>

<a href="https://kassinao.cloud/demo"><img src="docs/brand/discord-demo-pt.gif" width="900" alt="Fluxo fictício do Kassinão dentro do Discord"></a>

<sub>Demo fictícia, comandos e comportamento reais. Nenhum dado vem de um workspace de verdade.</sub>

</div>

---

As superfícies públicas do projeto são:

| Superfície | URL pública | Função |
|---|---|---|
| Site e demo | [kassinao.cloud](https://kassinao.cloud) | Apresentação pública do produto e demo fictícia |
| Documentação | [docs.kassinao.cloud](https://docs.kassinao.cloud) | Instalação, comandos, segurança e guias do MCP |
| Pacote MCP | [npm: kassinao-mcp](https://www.npmjs.com/package/kassinao-mcp) | Conector instalado no computador de cada pessoa |
| Código-fonte | [GitHub](https://github.com/resolvicomai/kassinao) | Código auditável, releases e issues |

**Não existe workspace hospedado, cadastro público ou acervo de reuniões compartilhado.** Cada operador cria seu próprio aplicativo no Discord e publica sua própria `APP_URL` privada. Os links de gravação e a configuração MCP gerados por esse deploy apontam para as origens do operador, nunca para a infraestrutura do mantenedor.

Uma instalação nova precisa apenas da própria `APP_URL`. `PUBLIC_URL`, `DOCS_URL` e `MCP_URL` são opcionais quando o operador decide separar as superfícies em domínios diferentes. `BASE_URL` é um alias legado de `APP_URL`, não a configuração recomendada para novos deploys.

A maioria dos bots de reunião começa com um áudio misturado e usa diarização para inferir quem falou. O Kassinão recebe uma stream separada do Discord por pessoa, então a identidade vem da conta que produziu a faixa, não de um palpite pelo padrão de voz.

## Sumário

- [Sabe quem falou](#sabe-quem-falou)
- [Vira memória que responde](#vira-memória-que-responde)
- [Veja a reunião pronta](#veja-a-reunião-pronta)
- [É seu, com controle real](#é-seu-com-controle-real)
- [Comece agora](#comece-agora)
- [Como se compara](#como-se-compara)
- [Referência](#referência)
- [Como funciona por dentro](#como-funciona-por-dentro)
- [Segurança e privacidade](#segurança-e-privacidade)

## Sabe quem falou

- Uma faixa de áudio própria por pessoa (FLAC, perfeitamente sincronizada) — não é diarização adivinhada por IA.
- O VAD normalmente envia só os trechos com fala. Se a detecção falhar, o Kassinão usa blocos fixos para não perder a call.
- Motor de transcrição plugável — AssemblyAI, Groq, OpenAI, Gemini ou um comando local, pra privacidade total.
- O vocabulário configurado ajuda com termos técnicos. Nomes, servidor e canal só são enviados ao motor quando o operador ativa `TRANSCRIBE_SEND_MEETING_CONTEXT=true`.
- Roda sozinha depois do `/parar` — a transcrição com nome de quem falou e timestamp chega sem apertar mais nada.

## Vira memória que responde

- Ata por IA: resumo, decisões e itens de ação, com responsável e prazo quando a transcrição sustenta essa informação.
- O canal do Discord recebe só um aviso genérico; participantes autorizados recebem o link privado e a ata por DM.
- `/perguntar` entende tema, pessoa, data da call e prazo da ação (como “ações da Ana que vencem hoje”). A IA só seleciona as fontes; o bot exibe a evidência real da ata/transcrição com link autorizado. A opção `dias` vale quando a pergunta não informa um período da call.
- Índice web com busca full-text em transcrições, atas e notas — cada resultado linka pro segundo exato.
- O mesmo acervo conecta no Claude Desktop, Cursor ou outro assistente compatível, via MCP.

> Exemplo: _"o que ficou pendente essa semana, e de quem?"_ — o `/perguntar` (ou o conector MCP) cruza itens de ação com prazo de várias reuniões e responde só com o que você tem direito de ver.

## Veja a reunião pronta

[![Reunião fictícia renderizada pela interface real do Kassinão](docs/brand/meeting-demo-pt.png)](https://kassinao.cloud/demo)

A demo pública usa dados fictícios e o mesmo renderer de uma gravação real. O idioma da interface pode mudar; o conteúdo original da reunião nunca é traduzido silenciosamente.

## É seu, com controle real

- Self-hosted: o bot e os arquivos rodam no seu Docker. Se você configurar um provider externo de transcrição ou ata, o áudio ou texto necessário é enviado a esse provider; o processamento local mantém tudo no servidor.
- Acesso exige login e vínculo atual com o servidor. A gravação fica somente com quem iniciou, quem esteve na call e admins atuais; enxergar o canal hoje não libera o histórico.
- Retenção do seu jeito: só o áudio expira, ou nada expira — você decide o que vira memória permanente.
- Painel ao vivo no canal (parar, marcar nota/momento com um clique) e indicador `[GRAVANDO]` visível pra quem está na call.
- Auto-record liga sozinho quando alguém entra no canal, é bilíngue (pt-BR/inglês) e roda sob código aberto AGPL-3.0-or-later.

## Comece agora

Precisa de um servidor com **Docker** e de um **app criado no Discord** — é rápido, veja o [passo 1](#1-criar-o-app-do-bot-no-discord) abaixo.

> Faça o passo 1 primeiro: sem `DISCORD_TOKEN` o bot nem sobe.

```bash
git clone https://github.com/resolvicomai/kassinao.git && cd kassinao
cp .env.example .env && chmod 600 .env
mkdir -p recordings && chmod 700 recordings
# Preencha DISCORD_TOKEN, APPLICATION_ID, DISCORD_CLIENT_SECRET, APP_URL
# e ALLOWED_GUILD_IDS. Mantenha ALLOW_ALL_GUILDS=false num bot privado.
docker compose up -d --build
```

Mantenha o `.env` pertencendo ao usuário do deploy e com modo `0600`. O `./scripts/inject-secrets.sh` recebe as duas credenciais obrigatórias do Discord e o token opcional do túnel sem mostrá-los na tela; nunca cole valores preenchidos em issue, chat, comando de shell ou log. O container roda sem root como UID/GID `1000` por padrão. Se um `recordings/` antigo pertence a root, rode `sudo chown -R 1000:1000 recordings`; IDs não-root diferentes podem ser definidos com `KASSINAO_UID` e `KASSINAO_GID`.

Em VPS Linux, instale o watchdog no host depois do primeiro deploy. Ele só pode reiniciar o container `kassinao` e substitui containers de autoheal com o socket do Docker montado:

```bash
sudo install -o root -g root -m 0755 scripts/health-watch.sh /usr/local/sbin/kassinao-health-watch
sudo install -o root -g root -m 0644 deploy/systemd/kassinao-health-watch.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kassinao-health-watch.timer
```

Antes de publicar o hostname, rode na VPS o gate de release somente leitura. Ele termina com erro quando encontra SSH por senha/root, firewall permissivo, listener público inesperado, privilégio inseguro no Docker ou arquivo de segredo com modo fraco:

```bash
sudo ./scripts/audit-vps-security.sh
# Exemplo quando o SSH usa outra porta:
sudo env KASSINAO_ALLOWED_PUBLIC_TCP_PORTS=2222 ./scripts/audit-vps-security.sh
```

Depois **convide o bot** (passo 1) e rode **`/gravar`** num canal de voz. Pronto — o passo a passo completo está logo abaixo.

> ☁️ **Deploy em 1 clique:** [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/resolvicomai/kassinao) - blueprint em [`render.yaml`](render.yaml). Ele cria a sua instância e pede sua URL, allowlist de guilds, credenciais do Discord e providers opcionais.
> Evite serverless (Vercel/Netlify): o gateway de voz do Discord precisa de um WebSocket sempre ativo.

### 1. Criar o app do bot no Discord

1. Em <https://discord.com/developers/applications> → **New Application** → dê um nome.
2. **General Information**: copie o **Application ID** → `APPLICATION_ID`.
3. **Bot** → **Reset Token** → copie → `DISCORD_TOKEN`. (Nenhuma _privileged intent_ é necessária.)
4. **Bot** → desligue **Public Bot**. Em instalação, mantenha apenas **Guild Install** e não publique um link geral de instalação.
5. **OAuth2** → copie o **Client Secret** → `DISCORD_CLIENT_SECRET`.
6. **OAuth2 → Redirects** → adicione exatamente `SUA_APP_URL/auth/callback`.
7. Convide o bot em uma guild da allowlist (troque `SEU_APP_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=SEU_APP_ID&scope=bot%20applications.commands&permissions=68242432
   ```
   Permissões: Ver Canais, Enviar Mensagens, Inserir Links, Ler Histórico de Mensagens, Conectar, Alterar Apelido.
   > Em canais **restritos**, libere no próprio canal todas as permissões acima, ou dê ao bot um cargo com esse acesso.

### 2. Deixar o bot acessível (escolha um)

**Opção A — Cloudflare Tunnel (recomendado: HTTPS, sem abrir portas)**

1. Em <https://one.dash.cloudflare.com> → **Networks → Tunnels → Create a tunnel → Cloudflared**.
2. Dê um nome, copie o **token** (`eyJ...`) → `TUNNEL_TOKEN` no `.env`.
3. Em **Public Hostname**: subdomínio + seu domínio, **Type = HTTP**, **URL = `kassinao:8080`**.
4. No `.env`, defina `APP_URL=https://kassinao.seu-dominio.com`, `COMPOSE_PROFILES=tunnel` e `TRUST_PROXY_HOPS=1` para essa topologia com um proxy.
   O serviço `cloudflared` do compose fica sob o profile `tunnel` e **não sobe sozinho** — sem o `COMPOSE_PROFILES=tunnel` (ou `docker compose --profile tunnel up -d`), o túnel simplesmente não inicia.
   Num deploy com domínios separados, aponte cada hostname para o mesmo serviço e defina também `PUBLIC_URL`, `DOCS_URL` e `MCP_URL`. Num self-host comum, deixe essas três vazias.

**Opção B - desenvolvimento local**

- Mantenha `APP_URL=http://localhost:8080`. Não exponha um IP puro. O OAuth do Discord aceita HTTP somente em localhost; para uso real, publique seu próprio hostname HTTPS.

O hostname é informação pública e não pode ser tratado como segredo. A proteção vem de `ALLOWED_GUILD_IDS`, vínculo atual com o Discord, OAuth e ACL de cada gravação. Mantenha o firewall da VPS fechado para tudo que não for operação intencional; o túnel evita expor diretamente a porta da aplicação.

### 3. Subir

```bash
docker compose up -d --build
docker compose logs -f     # deve mostrar "Kassinão online como ..."
```

As gravações ficam em `./recordings` (volume — sobrevivem a rebuilds).

### 4. (Opcional) Ligar transcrição + ata

Exemplo opt-in (AssemblyAI para voz, fallback explícito na Groq e OpenRouter para ata):

```env
TRANSCRIBE_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=...        # https://www.assemblyai.com
GROQ_API_KEY=gsk_...          # opcional: fallback da transcrição (https://console.groq.com)
TRANSCRIBE_FALLBACK_PROVIDER=groq
TRANSCRIBE_SEND_MEETING_CONTEXT=false
OPENROUTER_API_KEY=sk-or-...  # https://openrouter.ai - LLM da ata (padrão google/gemini-2.5-flash)
MINUTES_ENABLED=true
```

Para uma configuração mais leve, use `TRANSCRIBE_PROVIDER=groq` com `GROQ_API_KEY`; cotas e preços disponíveis dependem da conta.

> 🔒 **Privacidade:** no painel da Groq, ligue o **Zero Data Retention (ZDR)** para o áudio não ser retido. Ou use o motor **local** (`TRANSCRIBE_PROVIDER=command`) para o áudio nunca sair do servidor.

## Como se compara

Craig grava. Otter resume. O Kassinão sabe quem falou.

|                                                     | **Kassinão** |  Craig   | Otter / Fireflies |
| --------------------------------------------------- | :----------: | :------: | :---------------: |
| Multipista (um arquivo por pessoa)                  |      ✅      |    ✅    |        ❌         |
| Atribuição perfeita de quem falou (sem diarização)  |      ✅      |    ✅    |    ❌ (chuta)     |
| Ata por IA (resumo, decisões, tarefas)              |      ✅      |    ❌    |        ✅         |
| Detalhamento por participante                       |      ✅      |    ❌    |        ⚠️         |
| Self-hosted / o dado é seu                          |      ✅      |    ⚠️    |        ❌         |
| Acesso por login (não "quem tem o link")            |      ✅      |    ⚠️    |        ✅         |
| Código aberto (AGPL-3.0)                            |      ✅      |    ✅    |        ❌         |
| Preço                                               |    Grátis    | Freemium |       Pago        |

## Referência

Consulta rápida pós-instalação — não precisa ler isso pra decidir se instala, só quando for configurar.

### Configuração (`.env`)

Todas as opções estão comentadas, uma a uma, em [`.env.example`](.env.example). Aqui vão as principais:

| Variável | Padrão | Descrição |
|---|---|---|
| `DISCORD_TOKEN` | — | Token do bot |
| `APPLICATION_ID` | — | ID da aplicação |
| `DISCORD_CLIENT_SECRET` | — | Client Secret (login OAuth da página) |
| `APP_URL` | `http://localhost:8080` | Origem canônica do app privado, OAuth, links de gravação e downloads |
| `BASE_URL` | vazio | Alias legado de `APP_URL`; instalações novas não devem usar |
| `PUBLIC_URL` | `APP_URL` | Origem opcional da landing e demo públicas |
| `DOCS_URL` | `PUBLIC_URL` | Origem da documentação |
| `MCP_URL` | `APP_URL` | Origem privada da API consumida pelo `kassinao-mcp` |
| `ALLOWED_GUILD_IDS` | obrigatória | IDs dos servidores Discord aceitos pela instância (CSV) |
| `ALLOW_ALL_GUILDS` | `false` | Opt-in explícito para operador multi-guild público; nunca use para tornar a instância privada |
| `GUILD_ID` | vazio | Filtro opcional de registro de comandos; não concede acesso e precisa estar na allowlist |
| `TRUST_PROXY_HOPS` | `0` | Quantidade exata de proxies confiáveis; use `1` com a topologia do Cloudflare Tunnel incluído |
| `SOURCE_URL` | repositório upstream | Link de código exibido por `/sobre`; altere ao publicar um fork |
| `REPO_PUBLIC` | `false` | `true` exibe `SOURCE_URL` nas páginas privadas; a landing pública sempre aponta para o repositório-fonte configurado |
| `TUNNEL_TOKEN` | — | Token do Cloudflare Tunnel (Opção A; defina também `COMPOSE_PROFILES=tunnel`) |
| `PORT` | `8080` | Porta do servidor web |
| `WEB_BIND_ADDRESS` | `127.0.0.1` | Interface do modo bare-node; loopback por padrão. Docker usa wildcard só dentro do container isolado |
| `KASSINAO_HOST_PORT` | `8080` | Porta opcional publicada pelo Docker no host, sempre presa a `127.0.0.1` |
| `RECORDINGS_DIR` | `./recordings` | Onde salvar as gravações |
| `RETENTION_DAYS` | `7` | Dias até o **áudio** da gravação expirar (`0` = ilimitado: nada expira, apagar é só manual) |
| `TEXT_RETENTION_DAYS` | `90` | Quanto tempo transcrição/ata/notas sobrevivem ao áudio (nunca menor que `RETENTION_DAYS`; `0` = pra sempre) |
| `MAX_RECORDING_HOURS` | `6` | Duração máxima por gravação |
| `RECORDING_MAX_CONCURRENT` · `RECORDING_MAX_PENDING_PROCESSING` | `2` · `12` | Capacidade global de captura e processamento durável; todas as fases da sessão contam |
| `RECORDING_GUILD_STARTS_PER_24H` | `12` | Cota dura móvel por servidor, compartilhada por inícios manuais e automáticos, inclusive admins |
| `RECORDING_STARTS_GLOBAL_PER_HOUR` · `RECORDING_STARTS_GLOBAL_PER_24H` | `8` · `32` | Cotas duras globais de início em todas as guilds e origens |
| `MP3_BITRATE` | `192k` | Bitrate dos MP3 |
| `COOKIE_SECRET` | gerado | Segredo dos cookies de sessão (mín. 32 bytes se definido manualmente) |
| `TZ` | `America/Sao_Paulo` | Fuso das datas (a página usa o do navegador) |
| `DEFAULT_LOCALE` | `en` | Idioma padrão quando não há locale do usuário (ex.: DM); dentro dos servidores, cada pessoa vê no idioma do próprio Discord |
| `TRANSCRIBE_PROVIDER` | `none` | `none` / `assemblyai` / `openai` / `groq` / `gemini` / `command` |
| `TRANSCRIBE_MODEL` | por provider | Ex.: `universal-3-5-pro` (assemblyai), `whisper-large-v3` (groq) |
| `TRANSCRIBE_LANGUAGE` | `pt` | Idioma falado nas calls |
| `TRANSCRIBE_FALLBACK_PROVIDER` | `none` | Fallback opcional e explícito, atualmente `none` ou `groq` |
| `TRANSCRIBE_SEND_MEETING_CONTEXT` | `false` | Só envia participantes/servidor/canal ao ASR quando o operador habilita |
| `TRANSCRIBE_PROMPT` | — | Vocabulário fornecido pelo operador para o motor de ASR |
| `TRANSCRIBE_KEYTERMS` | — | Vocabulário fixo da equipe para AssemblyAI Universal-3.5-Pro |
| `TRANSCRIBE_COMMAND` | — | Comando local com `{input}`/`{output}` (provider `command`) |
| `TRANSCRIBE_TIMEOUT_FACTOR` | `5` | Watchdog do provider `command` |
| `ASSEMBLYAI_API_KEY` / `OPENAI_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` | — | Chaves dos providers habilitados explicitamente pelo operador |
| `MINUTES_ENABLED` | `false` | Ata com IA é opt-in; use `true` com provider e chave explícitos |
| `MINUTES_PROVIDER` / `OPENROUTER_API_KEY` | `openrouter` c/ chave | LLM da ata: `openrouter` (padrão `google/gemini-2.5-flash`) ou `groq` (padrão `llama-3.3-70b-versatile`) |
| `OPENROUTER_SITE_URL` | vazio | URL opcional de atribuição; nenhuma URL do mantenedor é enviada por padrão |
| `MINUTES_MAX_TOKENS` | `8192` | Teto de tokens da ata |
| `MINUTES_WEBHOOK_URL` / `MINUTES_WEBHOOK_SECRET` | — | Destino HTTPS e segredo dedicado de 32 bytes para assinar cada `minutes.ready` |
| `MCP_SECRET` | — | Liga o conector MCP (Claude/Cursor). Defina um segredo forte pra ativar; girar o valor revoga todos os conectores de uma vez |
| `OWNER_IDS` | — | IDs do Discord com acesso ao `/mcp` (CSV); membros comuns se conectam sozinhos em `/app/conectar-ia` |
| `MCP_ACCESS_TTL_MIN` / `MCP_REFRESH_TTL_DAYS` | `15` / `30` | Validade do token de acesso (minutos) e do refresh (dias) do conector MCP |

Tem mais: guarda de espaço em disco, alerta de disco cheio, backup automático via rclone — tudo comentado, uma opção por vez, em [`.env.example`](.env.example).

Ao atualizar uma instância existente, chaves de API não ativam mais egressos vizinhos sozinhas. Preserve apenas o comportamento que você usa de propósito: `TRANSCRIBE_FALLBACK_PROVIDER=groq` para fallback na Groq, `TRANSCRIBE_SEND_MEETING_CONTEXT=true` para enviar identidade da reunião ao ASR e `MINUTES_ENABLED=true` para atas com IA. Defina `OPENROUTER_SITE_URL` com a URL pública do seu próprio projeto somente se quiser atribuição no OpenRouter.

### Verificar o webhook de atas

O receptor precisa autenticar o corpo bruto exato da requisição antes de interpretar o JSON. O Kassinão envia:

```text
X-Kassinao-Event: minutes.ready
X-Kassinao-Schema-Version: 1
X-Kassinao-Delivery-Id: <UUID estável desta entrega>
X-Kassinao-Timestamp: <segundos Unix>
X-Kassinao-Signature: v1=<HMAC-SHA256 hexadecimal minúsculo>
```

Calcule `HMAC-SHA256(MINUTES_WEBHOOK_SECRET, timestamp + "." + corpoBruto)`, prefixe o digest hexadecimal minúsculo com `v1=`, confirme que os dois valores têm o mesmo tamanho em bytes e compare com uma função de tempo constante. Não interprete e serialize novamente o corpo antes da verificação. Rejeite timestamps mais de cinco minutos no passado ou no futuro e persista `X-Kassinao-Delivery-Id` antes de aplicar efeitos, para que uma nova tentativa não duplique trabalho. As tentativas mantêm o mesmo delivery id, mas usam timestamp e assinatura novos. Somente uma resposta `2xx` confirma a entrega.

### Trocar os domínios de uma instância existente

1. Cadastre a nova `APP_URL/auth/callback` no OAuth do Discord antes de virar a produção.
2. Troque DNS, rotas do túnel, `APP_URL`, `PUBLIC_URL`, `DOCS_URL` e `MCP_URL` na mesma janela de manutenção. Sessões do navegador não atravessam domínios, então as pessoas precisam entrar de novo.
3. Tokens MCP ficam vinculados à origem que os emitiu. Gere uma conexão nova e substitua, em cada cliente ativo, o bloco completo impresso pelo comando de troca.
4. Valide todas as novas origens e remova em seguida o callback OAuth, os registros DNS e as rotas de túnel substituídos. Hostnames aposentados não são atendidos pela aplicação.

Transcrição 100% local: com `TRANSCRIBE_PROVIDER=command` o áudio nunca sai do servidor. Wrapper pronto para faster-whisper em [`scripts/transcribe-local.py`](scripts/transcribe-local.py):

```env
TRANSCRIBE_PROVIDER=command
TRANSCRIBE_COMMAND=python3 ./scripts/transcribe-local.py {input} {output}
```

No Docker, construa com Python + faster-whisper na imagem: `docker compose build --build-arg LOCAL_TRANSCRIBE=1`. Qualquer comando serve, desde que escreva em `{output}` um JSON `[{"start":s,"end":s,"text":"..."}]`.

### Comandos

| pt-BR | inglês | o que faz |
|---|---|---|
| `/gravar [canal]` | `/record [channel]` | Começa a gravar (seu canal de voz, ou o indicado) |
| `/parar` | `/stop` | Encerra e gera o link com áudio, transcrição e ata |
| `/nota <texto>` | `/note <text>` | Marca uma nota no tempo atual (ou botão 📝 do painel) |
| `/status` | `/status` | Estado da gravação em andamento |
| `/gravacoes` | `/recordings` | Suas últimas gravações, com links (filtradas por acesso) — também linka pro índice web com busca full-text |
| `/perguntar <pergunta> [dias]` | `/ask <question> [days]` | Pergunte por tema, pessoa, data da call ou prazo — só você vê evidências reais das reuniões que pode acessar |
| `/config ata-canal/ver` | `/config minutes-channel/view` | Admin: escolhe o canal do aviso genérico; detalhes e links ficam nas DMs autorizadas |
| `/autorecord ligar/desligar/ver` | `/autorecord on/off/view` | Gravação automática por canal (admin) |
| `/mcp novo/revogar-tudo` | `/mcp new/revoke-all` | Só o dono do bot (`OWNER_IDS`): gera ou revoga o código de conexão do assistente de IA — membros comuns se conectam sozinhos em `/app/conectar-ia` |
| `/ajuda` | `/help` | Guia interativo (também responde por DM) |
| `/sobre` | `/about` | Autor, licença e link do código-fonte |

Qualquer membro pode iniciar uma gravação no canal em que está; quem tem **Gerenciar Servidor** também pode indicar outro canal que enxergue. Parar e anotar exige continuar enxergando o canal gravado; `/autorecord` e `/config` exigem **Gerenciar Servidor**. Apagar uma gravação (pela página) é restrito a quem iniciou ou a admins. `/mcp` só existe quando o conector está ligado (`MCP_SECRET` definido).

O conector MCP aplica a mesma regra da web, reunião por reunião. Configuração: [documentação MCP](https://docs.kassinao.cloud#mcp), [pacote no npm](https://www.npmjs.com/package/kassinao-mcp) ou [`mcp/`](mcp/) neste repositório.

### Motores de transcrição

| Provedor | Preço | Qualidade em pt-BR | Privacidade | Notas |
|---|---|---|---|---|
| **AssemblyAI** (`universal-3-5-pro`) | [Preço atual](https://www.assemblyai.com/pricing) | Forte | Nuvem | Aceita contexto do operador; fallback na Groq exige opt-in explícito |
| **Groq** (`whisper-large-v3`) | [Preço atual](https://groq.com/pricing) | Excelente | Nuvem (ative ZDR quando disponível) | Whisper hospedado e rápido |
| **OpenAI** (`whisper-1`) | [Preço atual](https://openai.com/api/pricing/) | Excelente | Nuvem | Segmentos com timestamp |
| **Gemini** (`gemini-3.5-flash`, padrão) | [Preço atual](https://ai.google.dev/gemini-api/docs/pricing) | Boa | Nuvem | Transcrição multimodal pela Gemini API |
| **Local** (`faster-whisper`) | Grátis | Boa (`small` ou maior) | 🔒 Nunca sai do seu servidor | Mais lento sem GPU; veja [`scripts/transcribe-local.py`](scripts/transcribe-local.py) |

> 💡 A gravação é multipista. O VAD normalmente corta o silêncio antes do envio; se a detecção falhar, entram blocos fixos para a call não ser perdida, e eles podem conter silêncio. Uso e custo variam com tempo falado, fallback, provider e modelo. A ata roda uma vez por reunião via OpenRouter ou Groq.

## Como funciona por dentro

Cada falante manda pacotes Opus pro `@discordjs/voice`, que são decodificados em PCM e alimentam **um ffmpeg por pessoa** gravando **FLAC contínuo** (o silêncio entre falas comprime a quase nada e mantém tudo sincronizado). Ao encerrar, o **mix já sai pré-cozido**; os demais downloads (MP3/FLAC/Audacity) são gerados sob demanda, com cache. Transcrição e ata rodam numa **fila serial** depois da call: o **VAD** (`silencedetect` do ffmpeg) normalmente envia os trechos com fala e usa blocos fixos se a detecção falhar; a ata roda em seguida num LLM via OpenRouter ou Groq. A página se atualiza sozinha até tudo ficar pronto, e autentica com **OAuth2 do Discord**; o backend confere no Discord, a cada acesso, se a pessoa pode abrir aquela gravação.

```mermaid
flowchart LR
    subgraph Discord
      VC[Canal de voz]
    end
    subgraph Kassinão
      BOT[Bot<br/>discord.js / voice]
      FF[ffmpeg por falante<br/>→ FLAC master]
      MIX[Mix pré-cozido<br/>demais downloads sob demanda]
      VAD[VAD silencedetect<br/>só trechos com fala]
      Q[Fila serial:<br/>transcrição → ata com IA]
      WEB[Página web<br/>Express + OAuth]
    end
    VC -- Opus por falante --> BOT --> FF
    FF -- ao parar --> MIX
    FF -- ao parar --> VAD --> Q
    Q -- "ASR: AssemblyAI / Groq / OpenAI / Gemini / local" --> Q
    Q -- "Ata: OpenRouter / Groq" --> Q
    MIX & Q --> WEB
    USER[Participante] -- Login com Discord --> WEB
    WEB -. Cloudflare Tunnel / HTTPS .-> USER
```

**Stack:** Node.js + TypeScript · discord.js / @discordjs/voice · Express · ffmpeg · Docker · Cloudflare Tunnel.

## Segurança e privacidade

Gravar voz é tratar **dado pessoal** — o design parte disso, não é um adendo:

- **Controle de acesso é código, não convenção.** Toda checagem — página web, central privada `/app`, API do conector MCP — passa pela mesma função em [`src/web/access.ts`](src/web/access.ts). Só abre para quem **iniciou**, **esteve na call** (falando ou mutado) ou é admin atual, sempre exigindo vínculo atual com o servidor. Enxergar o canal hoje não libera gravações antigas. Apagar continua restrito a quem iniciou ou a admins. Não existe um caminho "por disco" que pule essa regra.
- **A URL não é segredo nem fronteira de segurança.** A instância só admite `ALLOWED_GUILD_IDS`; OAuth, vínculo atual e ACL da gravação continuam obrigatórios mesmo quando alguém conhece o domínio.
- **Falha pro lado seguro.** Se o cache do Discord está frio (gateway reiniciando, rate limit), a página nunca _concede_ um acesso que não conseguiu confirmar — ela nega, e no caminho do conector MCP devolve um erro retriável (503) em vez de um 403 que poderia esconder um acesso legítimo.
- **Consentimento visível.** O apelido do bot vira `[GRAVANDO]` durante a call e um painel aparece no canal — ninguém é gravado sem saber.
- **O conector MCP não amplia acesso.** O token carrega só identidade — a regra de visibilidade é a mesma da web; o texto das reuniões chega ao seu assistente marcado como "dado não confiável" (defesa contra prompt-injection); girar o `MCP_SECRET` revoga todos os conectores na hora.
- **Áudio não precisa passar por terceiros.** Ligue **Zero Data Retention** no provedor escolhido ou rode o motor local. A ata com IA é um opt-in separado e envia texto da transcrição, nomes de participantes/falantes, nome do canal e notas marcadas, nunca o áudio. Contexto da reunião no ASR, fallback, atribuição do OpenRouter e webhook também são opt-ins separados.
- **Segredos ficam só no seu `.env`** (já no `.gitignore` por padrão), nunca comitados ou impressos em log. O subprocesso local de transcrição recebe um ambiente reduzido, sem o conjunto completo de segredos do bot. Reporte vulnerabilidades em [SECURITY.md](SECURITY.md).
- **A VPS tem gate verificável.** `scripts/audit-vps-security.sh` reprova SSH, firewall, listeners, isolamento Docker ou modos de segredo inseguros; rode no host real antes de cada release público.

## Desenvolvimento

Para rodar fora do Docker, instale **Node.js 22+**, deixe o **ffmpeg disponível no `PATH`** e tenha a toolchain exigida pelo `node-gyp`: **Python 3, `make` e um compilador C/C++** (no macOS, Xcode Command Line Tools).

```bash
npm ci --userconfig .npmrc.security
cp .env.example .env && chmod 600 .env
npm run dev     # reload automático
npm run build   # compila para dist/
```

## Contribuindo

Issues e PRs são bem-vindos. Rode `npm run build` antes de abrir um PR.

## Licença

[GNU AGPL-3.0-or-later](LICENSE) © 2026 Mauro Marques.

Software livre e de código aberto: você pode usar, estudar, modificar e
compartilhar — mas se rodar uma versão modificada como serviço de rede (ex.:
hospedar o bot para outras pessoas), a AGPL te obriga a oferecer o código-fonte
correspondente a esses usuários. O comando `/sobre` do bot já linka este
repositório para cumprir isso.

Usa o [ffmpeg](https://ffmpeg.org/) como binário externo separado (instalado pelo
repositório Debian assinado no Docker); a licença GPL/LGPL própria dele se aplica.
