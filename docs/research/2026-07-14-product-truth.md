# Verdade de produto e limites de comunicação do Kassinão

**Data da verificação original:** 14 de julho de 2026

**Escopo do snapshot:** estado observado no início da refatoração, repositório público, Discord, OAuth, gravação de voz, self-hosting, MCP, Docker/GHCR e supply chain.

**Status:** snapshot histórico de pré-implementação. Toda afirmação sobre versão pública, disponibilidade de artefatos ou estado da VPS vale apenas para a data acima. Para conhecer e operar o estado atual, use o [README](../../README.pt-BR.md), a [documentação](../../src/web/docs.ts), o [guia de segurança](../../SECURITY.md) e a página de [releases](https://github.com/resolvicomai/kassinao/releases), não este snapshot.

**Natureza:** relatório técnico público, sem credenciais, IDs de produção, domínios internos ou dados de reuniões. Não é parecer jurídico.

## Veredito executivo

O Kassinão pode ser comunicado com segurança como **um bot de Discord self-hosted que grava calls, preserva uma faixa por conta do Discord que fala, organiza o áudio e pode gerar transcrição, ata e consultas por IA quando o operador configura esses recursos**. Essa formulação continua correspondendo ao código. ([comandos](../../src/index.ts), [sessão de gravação](../../src/recorder/RecordingSession.ts), [defaults de configuração](../../src/config.ts))

No snapshot inicial, ainda não era defensável comunicar o projeto como “pronto para lançamento” sem ressalvas. A auditoria encontrou quatro bloqueadores de verdade pública:

1. **Privacidade da instância:** o repositório não continha uma política de privacidade do operador, um URL público de política nem um fluxo geral para uma pessoa pedir alteração/exclusão dos seus dados. O botão que apaga uma gravação não substitui esse processo. O Discord exige política pública atualizada, acessível pelo Developer Portal e pela aplicação, descrevendo coleta, uso, compartilhamento, retenção e exclusão; também exige uma forma acessível de pedir modificação/exclusão. ([Developer Terms, §5(a)-(b)](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service), [exclusão da gravação](../../src/web/server.ts))
2. **Proteção em repouso:** o container endurecia permissões e separava volumes, mas não provava a criptografia dos volumes ativos. Backup criptografado também não prova criptografia do dado ativo. O Discord inclui “encryption of the data at rest” entre os esforços de segurança exigidos para API Data. ([Developer Terms, §5(c)](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service), [Compose](../../docker-compose.yml), [backup](../../scripts/backup.sh))
3. **Distribuição pública:** em 14/07/2026, o repositório público ainda mostra `v1.4.4`, mutável e sem assets; o workflow público de imagem não existe em `main`; e não há pacote GHCR público resolvível em `ghcr.io/resolvicomai/kassinao`. A imagem `1.4.5`, o kit operacional e suas attestations existem apenas no worktree local até serem publicados. ([release pública v1.4.4](https://github.com/resolvicomai/kassinao/releases/tag/v1.4.4), [Actions públicas](https://github.com/resolvicomai/kassinao/actions), [workflow local ainda não publicado](../../.github/workflows/publish-image.yml))
4. **Copy que excedia o comportamento:** o texto prometia “consentimento”, “atribuição perfeita”, apelido sempre alterado, transcrição/ata automática e prazo de cerca de um minuto. O código garantia apenas aviso no chat antes da captura; a alteração do apelido era best effort; ASR/ata eram opt-in; e não existia SLA de processamento. ([i18n](../../src/i18n.ts), [início fail-closed](../../src/recorder/RecordingSession.ts), [transcrição](../../src/processing/transcribe.ts), [ata](../../src/processing/minutes.ts))

### Estado registrado no fim desta auditoria (histórico)

- **Privacidade:** o projeto agora separa a política genérica do distribuidor da política preenchida por cada operador; `OPERATOR_NAME`, `OPERATOR_CONTACT_URL`, `PRIVACY_POLICY_URL` e `DATA_DELETION_URL` integram o contrato de produção e a aplicação oferece a rota privada `/privacy`.
- **Storage:** o kit operacional exige storage LUKS comprovado antes de criar ou normalizar os diretórios de dados; `scripts/prepare-storage.sh` falha fechado quando origem, ownership, modo, symlink ou cobertura criptográfica não correspondem ao contrato.
- **Comunicação:** README, docs, comandos, landing e assets foram reescritos para falar em aviso, atribuição por conta/stream e recursos de IA opcionais, sem promessa de consentimento, perfeição ou SLA.
- **Distribuição:** à época, workflow, imagem por digest, kit sem checkout Git nem código-fonte da aplicação e cadeia de verificação existiam somente no worktree. O kit ainda continha controles operacionais públicos, templates e runtimes nativos; o item 3 dependia de publicação e prova numa VPS Linux. Consulte as fontes atuais indicadas no topo para saber o estado posterior.

O checklist da seção 15 continua sendo a fronteira entre “implementado localmente” e “comprovado em produção”.

## Método e hierarquia de fontes

1. **Comportamento:** código e testes do worktree atual são a fonte primária.
2. **Estado publicado:** GitHub/GHCR/npm consultados ao vivo em 14/07/2026.
3. **Regras da plataforma:** documentação e termos oficiais do Discord, Docker, GitHub, MCP e GNU.
4. **Regra de comunicação:** quando o código e a copy divergem, vale o código; quando o worktree e o artefato público divergem, vale o artefato público para instruções de instalação.

Este snapshot foi feito durante uma refatoração ampla e com o worktree sujo. Depois do merge, os checks de texto precisam ser repetidos antes do release.

## Estado público verificável em 14/07/2026

- O repositório `resolvicomai/kassinao` é público e usa `main` como branch padrão. ([repositório](https://github.com/resolvicomai/kassinao))
- A release pública encontrada é `v1.4.4`; ela não está marcada como imutável e não tem assets anexados. ([release v1.4.4](https://github.com/resolvicomai/kassinao/releases/tag/v1.4.4))
- Os workflows públicos encontrados são CI, CodeQL, Publish MCP e automações do Dependabot; `publish-image.yml` ainda não está em `main`. ([Actions](https://github.com/resolvicomai/kassinao/actions), [workflow local](../../.github/workflows/publish-image.yml))
- O endpoint público de packages respondeu “Package not found” para o container `kassinao`. Portanto, nenhum comando público deve depender hoje de `ghcr.io/resolvicomai/kassinao:1.4.5` ou de um digest ainda não publicado. ([packages do mantenedor](https://github.com/users/resolvicomai/packages?repo_name=kassinao), [Compose local](../../docker-compose.yml))
- `kassinao-mcp@1.0.6` era a versão `latest` no registro npm durante este snapshot e coincidia com o pacote local naquele momento. ([registro npm](https://registry.npmjs.org/kassinao-mcp/latest), [package MCP](../../mcp/package.json))

Consequência: a copy pode descrever a **intenção do pipeline local** usando futuro ou condição (“o workflow de release foi desenhado para…”), mas não pode dizer que cada release já publica imagem multiarch, kit operacional e attestations verificáveis.

## 1. O que o produto realmente é

Kassinão é um aplicativo/bot de Discord operado por quem faz o deploy. Ele entra em um canal de voz autorizado, registra áudio por streams associados a contas do Discord, mantém presença/notas/metadados, serve páginas autenticadas de gravação e oferece integrações opcionais de transcrição, ata, webhook e MCP. Não existe no projeto um workspace SaaS compartilhado nem cadastro público que centralize as reuniões de diferentes operadores. ([README](../../README.pt-BR.md), [RecordingSession](../../src/recorder/RecordingSession.ts), [servidor privado](../../src/web/server.ts), [API MCP](../../src/web/api.ts))

“Privado” significa **acesso autenticado e limitado pela instância**, não URL secreta. O hostname é observável; a fronteira é a combinação de allowlist de guilds, login Discord, vínculo atual com uma guild autorizada e ACL da gravação. ([configuração de guild](../../src/guildPolicy.ts), [ACL única](../../src/web/access.ts), [README](../../README.pt-BR.md))

### Projeto público x instância privada

- **Público:** fonte AGPL, documentação genérica, Dockerfile, workflow de build, exemplos sem segredo, templates e política do projeto enquanto distribuidor de software. ([licença](../../LICENSE), [Dockerfile](../../Dockerfile))
- **Privado por instância:** credenciais Discord/provider, allowlist de guilds, URLs escolhidas pelo operador, dados de reunião, sessões, tokens MCP, configuração de retenção, backups e runbooks da VPS. Esses itens não devem ir para Git, imagem pública, logs públicos ou assets de release. ([`.env.example`](../../.env.example), [`.gitignore`](../../.gitignore), [kit operacional](../../scripts/package-ops-bundle.sh))
- **Não pode ser mantido privado como simples “configuração”:** uma modificação do programa servida pela rede. A AGPL §13 determina que uma versão modificada ofereça o Corresponding Source a quem interage remotamente. Segredos, dados e parâmetros de execução não viram automaticamente Corresponding Source, mas patches de produto não podem ser escondidos sob o rótulo de “infra privada”. ([AGPL-3.0, §13](https://www.gnu.org/licenses/agpl-3.0.html), [explicação GNU](https://www.gnu.org/licenses/why-affero-gpl.html.en), [uso atual de `SOURCE_URL`](../../src/config.ts))

## 2. Instalação do aplicativo no Discord

### Modelo correto

Cada self-hoster cria **seu próprio aplicativo Discord**, seu bot, seu token e seu Client Secret. A instância oficial/empresarial pode usar `bot_public=false`; segundo a documentação do Discord, nesse estado somente o dono do aplicativo pode adicioná-lo a guilds. Isso é uma configuração do Developer Portal, não algo que o processo Node consiga garantir sozinho. ([Application Resource: `bot_public`](https://docs.discord.com/developers/resources/application), [configuração local](../../.env.example))

O contexto de instalação é **Guild Install**, porque o produto opera em servidores. A instalação em servidor precisa ser autorizada por uma pessoa com `MANAGE_GUILD`. Para o link de instalação, os scopes usados pelo projeto são `bot` e `applications.commands`. ([Application Resource: installation contexts](https://docs.discord.com/developers/resources/application), [OAuth2/scopes oficiais](https://docs.discord.com/developers/platform/oauth2-and-permissions), [README](../../README.pt-BR.md))

### Permissões pedidas

O bitfield documentado `68242432` corresponde a:

- `View Channel` (`1024`)
- `Send Messages` (`2048`)
- `Embed Links` (`16384`)
- `Read Message History` (`65536`)
- `Connect` (`1048576`)
- `Change Nickname` (`67108864`)

A soma é `68242432`. As cinco primeiras permissões são exigidas no canal para o início da captura; `Change Nickname` é recomendada, mas a gravação continua sem o indicador de apelido quando a mudança falha. ([permissões oficiais](https://docs.discord.com/developers/topics/permissions), [gate do canal](../../src/index.ts), [mudança best effort](../../src/recorder/RecordingSession.ts))

Não é correto pedir `Administrator`, `Manage Guild` ou `Manage Channels` ao bot para a gravação normal. `Manage Guild` é uma permissão **da pessoa** usada para administrar `/autorecord`, `/config` e certas ações de gravação; não faz parte do bitfield do bot. ([comandos](../../src/index.ts), [permissões oficiais](https://docs.discord.com/developers/topics/permissions))

### Intents

O client solicita `Guilds`, `GuildVoiceStates` e `DirectMessages`. Não solicita `GuildMembers`, `GuildPresences` nem `MessageContent`, os três intents privilegiados listados pelo Discord. ([client Discord](../../src/discord/client.ts), [Gateway e privileged intents](https://docs.discord.com/developers/events/gateway))

Isso **não** autoriza a frase “o bot nunca lê conteúdo de mensagem”. O handler de DM inspeciona `message.content` para detectar um `/comando` no início e responder com uma dica. O Discord entrega conteúdo de DMs com o próprio app como exceção mesmo sem o intent privilegiado Message Content. A formulação correta é: “o bot não solicita o intent privilegiado Message Content; em DMs ao bot, ele lê somente o necessário para detectar uma tentativa de slash command e responder ao onboarding”. ([handler de DM](../../src/index.ts), [exceções de Message Content](https://docs.discord.com/developers/events/gateway#message-content-intent))

## 3. OAuth e acesso web

O login web usa Authorization Code Grant com scope **somente `identify`**, callback `${APP_URL}/auth/callback` e `state` assinado/validado. `identify` dá acesso ao perfil básico; o código não pede `email` nem `guilds`. ([auth do Kassinão](../../src/web/auth.ts), [OAuth2 oficial](https://docs.discord.com/developers/topics/oauth2), [scopes oficiais](https://docs.discord.com/developers/platform/oauth2-and-permissions))

O vínculo atual com uma guild permitida não vem do OAuth do usuário. O servidor valida membership por chamadas do bot às guilds aceitas. Falha transitória fecha o acesso web e vira indisponibilidade temporária na API MCP; uma negativa definitiva impede acesso. ([membership e orçamento](../../src/web/access.ts), [autorização de login](../../src/web/server.ts), [Get Guild Member](https://docs.discord.com/developers/resources/guild))

### O que configurar no Developer Portal

O Portal não tem um campo chamado `APP_URL`. O mapeamento correto é:

| Configuração Kassinao | Campo/uso no Discord |
| --- | --- |
| `APP_URL` | Origem interna do produto; cadastrar **exatamente** `${APP_URL}/auth/callback` em **OAuth2 → Redirects**. O Discord exige que `redirect_uri` corresponda a uma URI registrada. |
| `PRIVACY_POLICY_URL` | **General Information → Privacy Policy URL**; precisa apontar para a política da instância/operador. |
| `TERMS_OF_SERVICE_URL` (opcional) | **General Information → Terms of Service URL**, caso o operador adote termos próprios. |
| Scopes/permissões de instalação | **Installation → Guild Install**: `bot`, `applications.commands`, bitfield `68242432`. |
| Visibilidade do bot oficial privado | **Bot → Public Bot** desligado (`bot_public=false`). |

O objeto oficial de Application contém campos distintos para `redirect_uris`, `privacy_policy_url`, `terms_of_service_url`, `install_params` e `custom_install_url`; uma URL não substitui semanticamente a outra. ([Application Resource](https://docs.discord.com/developers/resources/application), [OAuth2 Redirect URI](https://docs.discord.com/developers/topics/oauth2))

## 4. Fluxo real da gravação

1. O bot conecta ao canal com `selfMute=true` e `selfDeaf=false`.
2. Tenta adicionar `[GRAVANDO]`/`[RECORDING]` ao próprio apelido; uma falha é tolerada.
3. Publica o painel no chat do próprio canal de voz.
4. Se o painel não puder ser publicado, o start falha e é desfeito; `captureStarted` só vira `true` depois do painel.
5. A partir daí, o receiver passa a ouvir eventos de fala e cria/persiste faixas.
6. A presença no canal, mesmo sem fala, é registrada para compor acesso e histórico de presença.
7. Ao parar, o áudio fica disponível; transcrição e ata entram no pipeline somente se seus recursos estiverem habilitados.

Fontes: [start transacional](../../src/recorder/RecordingSession.ts), [checagem de permissões](../../src/index.ts), [pipeline de processamento](../../src/processing/transcribe.ts), [store](../../src/store.ts).

### Aviso não é consentimento

É defensável dizer “o Kassinão publica um aviso visível no chat do canal antes de começar a captura”. Não é defensável chamar esse painel de “consentimento” nem dizer “ninguém é gravado sem saber”. O código não coleta aceite individual, não bloqueia até todos aceitarem e permite auto-record administrativamente configurado. O Discord exige que o operador cumpra leis aplicáveis, respeite direitos de privacidade e mantenha os direitos necessários para operar e processar dados; a Developer Policy também proíbe iniciar processos em nome de usuários/servidores sem permissão devidamente informada. ([Developer Terms, §4](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service), [Developer Policy, itens 1-3](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy), [auto-record](../../src/recorder/autorecord.ts))

A política e a documentação devem orientar o operador a obter a base/consentimento exigido na sua jurisdição e na sua organização, especialmente antes de ativar auto-record. O produto oferece **disclosure técnico**; não certifica conformidade jurídica.

### Faixas e atribuição

O claim tecnicamente correto é “uma faixa por conta do Discord que fala”. Pessoas silenciosas aparecem na presença/ACL, mas não necessariamente têm arquivo de áudio. A separação evita uma etapa de diarização entre streams do Discord; ela não prova identidade humana, não elimina contas compartilhadas/apelidos ambíguos e não impede áudio incompleto, perda de pacotes ou falha parcial de uma faixa. O próprio pipeline suporta transcrição `partial`. ([UserTrack](../../src/recorder/UserTrack.ts), [participantes e presença](../../src/recorder/RecordingSession.ts), [estado parcial](../../src/processing/transcribe.ts))

Use “atribuição por conta/stream do Discord” ou “faixas separadas por pessoa que fala”; não use “atribuição perfeita”.

### Parada e processamento

A gravação pode terminar por comando/botão, canal vazio, população abaixo do mínimo no auto-record, limite máximo, desconexão ou proteções operacionais. O aviso de silêncio não para sozinho. O tempo de transcrição e ata depende de duração, provider, rate limits, retries e filas; não há SLA de “~1 minuto”. ([parada automática](../../src/index.ts), [sessão](../../src/recorder/RecordingSession.ts), [retries de transcrição](../../src/processing/transcribe.ts))

## 5. Comandos reais

O comando canônico é em PT-BR e recebe localization em inglês no Discord:

| PT-BR | Inglês | Comportamento/limite real |
| --- | --- | --- |
| `/gravar [canal]` | `/record [channel]` | Inicia no canal atual; quem tem Manage Server pode apontar outro canal visível. Áudio sempre; transcrição/ata só se configuradas. |
| `/parar` | `/stop` | Encerra a sessão que a pessoa pode controlar. |
| `/nota texto` | `/note text` | Adiciona nota no tempo atual. |
| `/status` | `/status` | Estado da gravação em andamento. |
| `/ajuda` | `/help` | Guia interativo. |
| `/gravacoes` | `/recordings` | Gravações recentes e índice privado conforme ACL. |
| `/autorecord ligar/desligar/ver` | `/autorecord on/off/view` | Requer Manage Server; automatiza o início por população do canal. |
| `/perguntar pergunta [dias]` | `/ask question [days]` | Consulta transcrições acessíveis; depende do provider de ata/LLM habilitado. |
| `/config ata-canal/ver` | `/config minutes-channel/view` | Requer Manage Server; canal de aviso genérico/configuração. |
| `/sobre` | `/about` | Autor, licença e fonte correspondente. |
| `/mcp novo/revogar-tudo` | `/mcp new/revoke-all` | Só é registrado quando MCP está ligado; no código atual, os subcomandos são restritos a `OWNER_IDS`. Membros comuns usam `/app/conectar-ia`. |

Fonte: [construção e registro dos comandos](../../src/index.ts).

Os comandos globais são apagados e os comandos atuais são registrados apenas nas guilds autorizadas. Isso permite dizer “a instância registra comandos apenas no seu perímetro”, mas não “o Discord impede que alguém tente adicionar o bot em outro servidor” — essa segunda parte depende de `bot_public=false` no Portal e da política de guild do runtime. ([registro de comandos](../../src/index.ts), [Application Resource](https://docs.discord.com/developers/resources/application))

## 6. Regra de acesso real

Web e MCP usam a mesma primitiva de autorização. Depois de confirmar membership **atual** em uma guild permitida:

- vê quem iniciou, quem esteve na call (falando ou mutado) ou quem tem `Manage Guild` agora;
- apaga quem iniciou ou quem tem `Manage Guild` agora;
- ganhar `View Channel` depois não abre o histórico;
- sair da guild encerra o acesso;
- quando Discord não consegue confirmar as camadas de servidor, o acesso fecha ou devolve erro temporário, conforme a superfície.

Fonte: [ACL única](../../src/web/access.ts).

Esse é um claim forte e suportado: “o acesso é revalidado contra membership atual e ACL da gravação”. Não o transforme em “impossível de invadir” ou “ninguém sem GitHub acessa”: GitHub não participa do login de usuários finais, e nenhuma aplicação conectada à internet é invulnerável.

## 7. Dados, retenção e egress

### Defaults

- `TRANSCRIBE_PROVIDER=none`
- `TRANSCRIBE_FALLBACK_PROVIDER=none`
- `MINUTES_ENABLED=false`
- `MCP_SECRET` vazio/desligado
- `RETENTION_DAYS=7` para áudio
- `TEXT_RETENTION_DAYS=90` para transcrição, ata, notas e metadados textuais, nunca abaixo da retenção de áudio; `0` significa retenção ilimitada/manual.

Fontes: [config](../../src/config.ts), [`.env.example`](../../.env.example), [limpeza/retention no store](../../src/store.ts).

Portanto, uma instalação nova **grava áudio**, mas não transcreve, não gera ata e não abre MCP até o operador configurar cada egress deliberadamente. Copy de feature pode dizer “pode gerar”; onboarding e comandos precisam dizer “quando habilitado”.

### O que pode sair da VPS

- Provider externo de ASR recebe chunks/arquivos de áudio. Quando `TRANSCRIBE_SEND_MEETING_CONTEXT=true`, também pode receber nomes, servidor/canal e keyterms de contexto; o default é `false`. ([transcribe](../../src/processing/transcribe.ts), [config](../../src/config.ts))
- Provider de ata recebe a transcrição, participantes, notas, nomes de speakers e contexto necessário para gerar o documento. ([minutes](../../src/processing/minutes.ts))
- `/perguntar` usa o mesmo provider LLM configurado para atas. ([minutes/llmChat](../../src/processing/minutes.ts), [handler de pergunta](../../src/index.ts))
- Webhook, quando configurado, recebe a ata por HTTPS fora de localhost, com timestamp, delivery ID e HMAC; não há webhook por default. ([webhook](../../src/minutesWebhook.ts), [validação](../../src/config.ts))
- O cliente MCP recebe os resultados das reuniões que a identidade tem direito de ver. ([API](../../src/web/api.ts), [cliente MCP](../../mcp/src/index.ts))

Assim, “self-hosted” não significa “offline” nem “os dados nunca saem da sua infraestrutura”. A formulação segura é: “o arquivo primário e o controle da instância ficam no storage do operador; egress para ASR, LLM, webhook e MCP ocorre apenas nos caminhos que ele configura”. A política do operador deve nomear os providers efetivamente usados.

### Transcrição local

`TRANSCRIBE_PROVIDER=command` é suportado, mas a imagem padrão instala somente runtime para providers externos. O build local requer `--build-arg LOCAL_TRANSCRIBE=1` ou uma imagem customizada com o executável configurado. Logo, “processamento local” é uma opção de build do operador, não uma propriedade da imagem padrão. ([Dockerfile](../../Dockerfile), [transcribe command](../../src/processing/transcribe.ts))

## 8. MCP

O pacote `kassinao-mcp` é um servidor MCP local por stdio. Ele roda na máquina do cliente MCP e conversa por HTTPS com a origem `KASSINAO_URL` da instância; não existe uma API compartilhada do mantenedor embutida no pacote. A arquitetura oficial do MCP distingue servidores locais stdio de servidores remotos HTTP. ([cliente do Kassinão](../../mcp/src/index.ts), [validação de origem](../../mcp/src/tokenAuth.ts), [arquitetura MCP](https://modelcontextprotocol.io/docs/learn/architecture))

As cinco tools atuais são:

- `list_meetings`
- `pending_actions`
- `search_meetings`
- `who_said`
- `get_meeting`

Elas consultam dados; não apagam gravações, não iniciam gravação e não escrevem no Discord. O protocolo MCP permite tools com efeitos arbitrários em geral, então a alegação “read-only” deve ser feita especificamente sobre **as cinco tools desta versão**, não sobre MCP como tecnologia. ([tools do Kassinão](../../mcp/src/index.ts), [conceitos oficiais de tools](https://modelcontextprotocol.io/docs/learn/server-concepts))

O fluxo usa código de troca de uso único com expiração aproximada de cinco minutos, refresh rotativo e storage local protegido por modo `0600` em Unix (`0700` para diretórios). `KASSINAO_URL` é obrigatório e HTTP só é aceito em localhost; fora disso, HTTPS é exigido. ([tokens server-side](../../src/web/mcpTokens.ts), [store do cliente](../../mcp/src/credentialStore.ts), [validação](../../mcp/src/tokenAuth.ts))

As respostas marcam transcrições, atas, notas, nomes e snippets como conteúdo não confiável e instruem o host a não tratá-los como comandos. Isso é defesa em profundidade; não prova que todo cliente/LLM vai resistir a prompt injection. ([tool output](../../mcp/src/toolOutput.ts))

Use “clientes MCP compatíveis” e cite apenas clientes testados. Não use “qualquer cliente MCP”.

## 9. Docker, GHCR, digest e attestations

### O que o worktree foi desenhado para fazer

O workflow local de release:

- só roda em tags `v*` que correspondem à versão e ao head revisado de `main`;
- exige variáveis que confirmem política de release imutável e proteção de tags;
- roda audit, signatures, lint, format, testes e build;
- constrói `linux/amd64` e `linux/arm64` com provenance e SBOM;
- verifica imagem com Trivy;
- cria attestation para o digest OCI e para o kit operacional;
- publica uma release e só promove tags móveis depois que a release fica verificavelmente imutável.

Fonte: [publish-image.yml local](../../.github/workflows/publish-image.yml).

O kit operacional é montado sem checkout Git, código-fonte da aplicação ou credenciais. Ele contém controles operacionais públicos selados em Shell/Python, templates sem segredos e runtimes nativos, e sela no template uma imagem `ghcr.io/...@sha256:...`, manifesto e checksum. O script de deploy rejeita kit alterado, deploy dentro de Git, imagem sem digest e vários estados operacionais inseguros. Isso sustenta o modelo “a VPS de produção puxa um artefato pré-construído e não precisa clonar/buildar o GitHub” **depois que o artefato for publicado**. ([package-ops-bundle](../../scripts/package-ops-bundle.sh), [deploy-release](../../scripts/deploy-release.sh))

Docker Compose aceita imagens endereçadas por tag ou digest; o digest fixa o conteúdo selecionado. Uma attestation adiciona proveniência verificável ligando artefato, workflow e commit, mas o próprio GitHub alerta que attestation não garante que o artefato é seguro. Ela precisa ser verificada e avaliada contra uma política. ([Compose `image`](https://docs.docker.com/reference/compose-file/services/#image), [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), [integridade de release](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity))

### Limite de rede

O Compose prende portas do app em `127.0.0.1`, usa filesystem raiz read-only, `no-new-privileges`, `cap_drop: ALL`, usuário não-root e limites de recursos. São controles reais. ([Compose](../../docker-compose.yml))

Eles não tornam a VPS “fora da internet” nem substituem firewall do host. O Docker alerta que portas publicadas podem contornar regras do ufw/firewalld e que controles devem considerar as chains do Docker, especialmente `DOCKER-USER`; binding em loopback é importante, mas precisa ser combinado com versão atual do Docker e controles do host. ([Docker: port publishing](https://docs.docker.com/engine/network/port-publishing/), [Docker e iptables](https://docs.docker.com/engine/network/firewall-iptables/), [controles de host do Kassinão](../../scripts/install-host-controls.sh))

## 10. Solução mínima defensável de privacidade para self-host

### Duas políticas, com responsabilidades diferentes

**1. Política do projeto público.** Um `PRIVACY.md`/documento equivalente no repositório deve explicar que baixar o software não envia reuniões ao mantenedor; listar telemetria do projeto, se existir; apontar canal de segurança/suporte; e deixar explícito que não é a política de cada deploy. Ele pode fornecer um template, mas não pode prometer providers, retenção, contato ou criptografia de um operador que o projeto não controla. Essa separação decorre do fato de cada operador criar e operar sua própria Application, sendo responsável por operação, suporte e dados. ([Developer Terms, §§3(c), 5](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service), [modelo self-host](../../README.pt-BR.md))

**2. Política da instância/operador.** Cada deploy precisa publicar sua própria política, com identidade e contato do controlador/operador, dados coletados, finalidades, providers/subprocessadores, egress, retenção efetiva, exclusão/modificação, incidentes e proteção em repouso. O link deve estar no Developer Portal e facilmente acessível dentro da aplicação. Isso é exigência textual do Discord; um link genérico para a política do GitHub upstream não descreve a instância real. ([Developer Terms, §5(a)-(c)](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service))

### Campos e gates identificados no snapshot

Os nomes abaixo foram a proposta mínima resultante da auditoria e agora fazem parte do contrato de configuração. Em produção, o boot valida presença, formato, origem e coerência quando isso é verificável pelo processo; veracidade do conteúdo e operação humana continuam sendo responsabilidade auditável do operador:

| Campo/gate | Regra mínima | Uso |
| --- | --- | --- |
| `APP_URL` | Obrigatório em produção; origem HTTPS fora de localhost. | OAuth, gravações e downloads privados. |
| `PRIVACY_POLICY_URL` | Obrigatório em produção; deve ser exatamente `${APP_URL}/privacy`. | Portal, `/sobre`, ajuda, login e rodapé da app. |
| `DATA_DELETION_URL` | Obrigatório em produção; deve ser exatamente `${APP_URL}/privacy#data-rights`. | Processo para pedir modificação ou exclusão de API Data. |
| `OPERATOR_NAME` | Obrigatório em produção. | Identificar quem opera/controla a instância. |
| `OPERATOR_CONTACT_URL` | Obrigatório e público. | Suporte, reports, incidentes e direitos de dados. |
| `TERMS_OF_SERVICE_URL` | Opcional, salvo necessidade jurídica do operador. | Campo de Terms no Portal e rodapé. |
| `SOURCE_URL` | Obrigatório em produção; aponta para o Corresponding Source exato da versão/fork. | AGPL §13 e `/sobre`. |

Fontes para a necessidade: [Application fields oficiais](https://docs.discord.com/developers/resources/application), [Developer Terms, §5](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service), [Developer Policy: reports e suporte](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy), [config atual](../../src/config.ts).

O boot pode validar sintaxe/HTTPS e presença desses campos. Ele não consegue validar sozinho que o texto da política é verdadeiro, que um e-mail recebe respostas ou que o volume do host está criptografado. Esses fatos precisam de gate operacional e evidência.

### Conteúdo mínimo da política da instância

A política deve refletir a configuração efetiva e cobrir, no mínimo:

1. Identificadores e perfil básico do Discord usados no login e na atribuição.
2. Presença em canal, nomes/apelidos e grants históricos usados pela ACL.
3. Áudio, notas, transcrição, ata, ações e metadados operacionais.
4. Cookies/sessões web e tokens MCP.
5. `RETENTION_DAYS` e `TEXT_RETENTION_DAYS` reais, incluindo o significado de `0`.
6. Providers de ASR/LLM, webhook, backup e qualquer outro service provider realmente habilitado.
7. Quem pode apagar pela interface e como qualquer pessoa afetada pode pedir modificação/exclusão fora desse ACL.
8. Como a pessoa recebe confirmação e qual é o prazo/processo do operador.
9. Contato para privacidade, suporte, abuso e incidente.
10. Descrição verdadeira da proteção em repouso e em trânsito, sem afirmar criptografia que não foi verificada.

Fontes de comportamento: [config](../../src/config.ts), [store](../../src/store.ts), [ACL](../../src/web/access.ts), [ASR](../../src/processing/transcribe.ts), [ata](../../src/processing/minutes.ts), [MCP](../../src/web/mcpTokens.ts). Fonte normativa: [Developer Terms, §5](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service).

### Proteção at-rest: o que documentar e o que enforçar

O container não tem como criptografar o disco da VPS de forma confiável. `read_only`, modos `0600/0700`, usuário não-root, volumes separados e backup criptografado são controles úteis, mas não equivalem a criptografia dos volumes ativos. ([Compose](../../docker-compose.yml), [deploy-release](../../scripts/deploy-release.sh), [Developer Terms, §5(c)](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service))

Modelo mínimo:

1. Colocar Docker data root, bind mounts de recordings/state/auth e snapshots temporários em storage cifrado do host: volume/cloud disk com criptografia at-rest documentada pelo provedor **ou** volume LUKS/dm-crypt administrado pelo operador.
2. Tratar criptografia do backup como uma camada separada; ela não cobre os dados ativos.
3. Guardar a evidência no runbook privado da instância: qual volume, qual mecanismo, cobertura dos mounts e data da última verificação.
4. Fazer o deploy falhar quando os mounts esperados não estão no storage aprovado, onde isso é tecnicamente detectável. `lsblk`/device mapper pode provar LUKS local; criptografia transparente do provedor normalmente exige evidência/API do provedor e não é inferível pelo container.
5. Não aceitar um simples booleano `ENCRYPTED=true` como prova técnica. No máximo, ele é uma declaração operacional auditável.
6. Exibir em copy somente a formulação que a instância verificou. Para o projeto genérico: “suporta deploy em storage criptografado; o operador deve habilitar e comprovar a proteção em repouso”. Para uma instância oficial: só dizer “dados criptografados em repouso” depois da verificação do host.

Isso separa corretamente a responsabilidade do software da responsabilidade do operador, sem transformar uma limitação do container em promessa falsa.

## 11. Claims permitidos

As frases abaixo podem ser usadas em landing, README, docs, Product Hunt e comandos, respeitando o contexto:

- **“Kassinão é um bot de Discord self-hosted para gravar e transformar calls em memória pesquisável.”** ([fluxo real](../../src/recorder/RecordingSession.ts))
- **“O bot publica um aviso no chat do canal antes de iniciar a captura; o indicador no apelido é best effort.”** ([start fail-closed](../../src/recorder/RecordingSession.ts))
- **“Cada conta do Discord que fala ganha uma faixa de áudio separada, preservando a atribuição por stream sem diarização posterior.”** ([UserTrack](../../src/recorder/UserTrack.ts))
- **“O áudio fica disponível ao encerrar; transcrição, ata, `/perguntar`, webhook e MCP são recursos opcionais configurados pelo operador.”** ([config](../../src/config.ts), [pipeline](../../src/processing/transcribe.ts))
- **“O login pede apenas o scope `identify`; o servidor revalida membership atual e ACL da gravação.”** ([auth](../../src/web/auth.ts), [access](../../src/web/access.ts))
- **“Quem saiu do servidor perde o acesso; receber permissão de canal depois não abre reuniões passadas.”** ([access](../../src/web/access.ts))
- **“Não há workspace compartilhado do mantenedor: cada operador usa sua própria aplicação Discord, URLs, credenciais e storage.”** ([modelo de configuração](../../.env.example), [README](../../README.pt-BR.md))
- **“As cinco tools MCP desta versão são de consulta e obedecem à mesma ACL da web.”** ([MCP](../../mcp/src/index.ts), [API](../../src/web/api.ts))
- **“O código é AGPL e a configuração, as credenciais e os dados da instância ficam fora do repositório.”** ([LICENSE](../../LICENSE), [`.gitignore`](../../.gitignore))
- **“A URL não é segredo nem fronteira de segurança.”** ([host/auth/ACL](../../src/web/server.ts))

## 12. Claims condicionais

Use somente quando a condição estiver explícita e comprovada:

- **“Gera transcrição e ata automáticas”** → “quando ASR e ata estão habilitados pelo operador”. Defaults são `none`/`false`. ([config](../../src/config.ts))
- **“Processa localmente”** → somente em imagem customizada com `TRANSCRIBE_PROVIDER=command` e runtime instalado. ([Dockerfile](../../Dockerfile))
- **“Dados criptografados em repouso”** → somente para uma instância cujo storage ativo foi verificado; nunca como claim universal do projeto. ([Developer Terms, §5(c)](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service))
- **“Imagem oficial por digest com provenance/SBOM/attestation”** → somente depois que o workflow, pacote GHCR e artefatos estiverem públicos e a instalação documentada for testada. ([GitHub attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations))
- **“Release imutável”** → somente quando o GitHub mostrar `Immutable` e `gh release verify` passar. ([integridade de release](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity))
- **“Compatível com clientes MCP testados”** → sempre nomear os clientes e versões realmente validados.
- **“Em conformidade com LGPD/GDPR”** → não usar como claim do software. No máximo, dizer que o projeto oferece controles que ajudam o operador, cuja conformidade depende de configuração, política, base legal e operação. ([Developer Terms, §5](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service))

## 13. Claims proibidos

| Não publicar | Motivo |
| --- | --- |
| “Consentimento visível” / “consentimento garantido” | O painel é aviso; não há aceite individual. |
| “Ninguém é gravado sem saber” | O código não consegue provar ciência/consentimento de cada participante, especialmente com auto-record. |
| “Atribuição perfeita de quem falou” | É atribuição por conta/stream, sujeita a identidade ambígua e falhas parciais. |
| “Transcrição e ata sempre automáticas” | Defaults desligados e providers opcionais. |
| “Tudo fica pronto em ~1 minuto” | Não há SLA; duração, fila, provider e retries variam. |
| “Cada pessoa tem uma faixa” sem qualificação | Só quem fala cria faixa; pessoa silenciosa pode existir apenas na presença/ACL. |
| “O bot não lê conteúdo de mensagem” | Ele lê o prefixo de DMs para detectar `/comando`; o claim correto é sobre não pedir o intent privilegiado. |
| “Funciona com qualquer cliente MCP” | Compatibilidade depende da implementação do host/stdio/config. |
| “Protegido contra prompt injection” | Conteúdo é marcado como não confiável, mas o comportamento final também depende do host/modelo. |
| “Self-hosted, então os dados nunca saem” | ASR, LLM, webhook, MCP e backup configurados são egress reais. |
| “Seguro porque a URL é privada” | Hostnames são públicos; segurança vem de autenticação, autorização e host hardening. |
| “Ninguém sem GitHub entra” | Usuários finais entram com Discord; GitHub não é a fronteira da app. |
| “Inhackeável”, “zero risco” ou equivalentes | Nenhum controle prova isso. |
| “Attestation prova que a imagem é segura” | Attestation prova proveniência sob uma política; não ausência de vulnerabilidade. |
| “v1.4.5/GHCR/kit operacional já disponíveis” | Estado público consultado não contém esses artefatos. |
| “O servidor oficial usa patches privados do produto” | Modificações de programa servidas pela rede acionam a oferta de source da AGPL §13. |
| “Produto oficial/parceiro do Discord” | Os termos proíbem sugerir parceria, patrocínio ou endorsement sem aprovação prévia. ([Developer Terms, §8(c)](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service)) |

## 14. Divergências encontradas e tratamento

### P0 do snapshot

1. **Comandos e i18n — tratado:** `/gravar`, ajuda, parada e privacidade agora distinguem áudio imediato de IA opcional e usam aviso/atribuição por stream, sem consentimento ou SLA inventados. ([comandos](../../src/index.ts), [i18n](../../src/i18n.ts))
2. **Painel antes da captura — tratado:** o start continua fail-closed e a comunicação não apresenta gravação sem painel como caminho normal. ([RecordingSession](../../src/recorder/RecordingSession.ts), [i18n](../../src/i18n.ts))
3. **Conteúdo de DM — tratado:** código e documentação explicam a leitura mínima do prefixo de DMs sem alegar que nenhum conteúdo é lido. ([client](../../src/discord/client.ts), [DM handler](../../src/index.ts))
4. **Docs e marketing — tratado:** saíram consentimento, nickname garantido, outputs incondicionais e claims comerciais temporais sem fonte. ([docs](../../src/web/docs.ts))
5. **Release pública — ainda externo:** README e docs descrevem o fluxo verificável, mas nenhum artefato deve ser anunciado antes de release, GHCR, assets e attestations existirem publicamente e passarem pela verificação documentada. ([README](../../README.pt-BR.md), [estado público](https://github.com/resolvicomai/kassinao/releases))
6. **Política — software tratado; operação pendente:** política do projeto, template/rota da instância, URL de exclusão e gates de produção existem. Preencher e validar a política real no Portal continua sendo ação do operador. ([Developer Terms, §5](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service))
7. **Storage — gate implementado; prova pendente:** o helper exige LUKS antes da mutação, mas a evidência só existe depois de executar e auditar o bundle na VPS dedicada real. ([Developer Terms, §5(c)](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service))

### P1 aplicado à comunicação atual

1. Não há tabela comparativa sem evidência primária nem claim de “atribuição perfeita”.
2. A compatibilidade é descrita como “clientes MCP compatíveis” e limitada às versões realmente testadas.
3. Áudio imediato e outputs de IA opcionais aparecem como etapas distintas.
4. Product Hunt/LinkedIn não devem dizer “live” antes do listing estar publicado e funcional.
5. A comunicação informa que o Kassinão é um projeto independente, sem afiliação ou endosso do Discord. ([Developer Terms, §8](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service))
6. A superfície pública usa somente URLs públicas parametrizadas; `APP_URL`, IDs, guilds, nomes, métricas internas e domínios privados não entram na landing/docs/assets.

## 15. Gate de verdade antes do lançamento

O lançamento só deve receber status “pronto” quando todos os itens abaixo forem verdadeiros no ambiente público, não apenas no worktree:

- [ ] Política pública da instância publicada, preenchida com operador, dados, providers, retenção, exclusão e contato.
- [ ] `Privacy Policy URL` preenchido no Developer Portal e link acessível a partir da aplicação.
- [ ] Fluxo de pedido de alteração/exclusão testado por uma conta externa e com responsabilidade operacional definida.
- [ ] Storage ativo da VPS verificado como criptografado em repouso; evidência no runbook privado.
- [ ] Bot privado oficial com Guild Install, scopes mínimos, bitfield correto e redirect exato.
- [ ] Teste com conta não autorizada: domínio conhecido não concede acesso.
- [ ] Teste com pessoa que saiu da guild: acesso web e MCP revogados/negados.
- [ ] Teste de painel: sem permissão de enviar mensagem, nenhuma captura começa.
- [ ] Teste sem `Change Nickname`: gravação começa com painel e copy não promete apelido.
- [ ] Teste de instalação default: grava áudio e explica que IA está desligada.
- [ ] Testes separados com ASR, ata, webhook e MCP habilitados, incluindo disclosure de egress.
- [ ] `publish-image.yml` em `main`, tag de release criada pelo fluxo protegido, GHCR público por digest e assets anexados.
- [ ] `gh attestation verify` passa para o digest OCI e kit; `gh release verify` e `verify-asset` passam.
- [ ] Instalação limpa a partir do kit público em VPS sem clone Git e healthchecks verdes.
- [ ] README, docs, comandos, landing, demos e launch assets passam por busca final dos claims proibidos.

## Fontes oficiais principais

### Discord

- [Developer Terms of Service](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service)
- [Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy)
- [Application Resource](https://docs.discord.com/developers/resources/application)
- [OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [OAuth2 and Permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
- [Permissions](https://docs.discord.com/developers/topics/permissions)
- [Gateway and Intents](https://docs.discord.com/developers/events/gateway)
- [Guild Resource](https://docs.discord.com/developers/resources/guild)
- [Voice Connections](https://docs.discord.com/developers/topics/voice-connections)

### GitHub, Docker, MCP e GNU

- [GitHub: artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub: verify release integrity](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [GitHub: immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [Docker Compose service image](https://docs.docker.com/reference/compose-file/services/#image)
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)
- [Docker firewall/iptables](https://docs.docker.com/engine/network/firewall-iptables/)
- [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts)
- [GNU AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html)
- [Why the GNU Affero GPL](https://www.gnu.org/licenses/why-affero-gpl.html.en)
