# Kassinão Project Privacy Notice and Operator Checklist

Effective date: 14 July 2026

This document describes the **public Kassinão project as a software distributor**. It is not the privacy policy of any Kassinão deployment and does not grant an upstream maintainer access to self-hosted meeting data.

Every deployment is operated independently. For a recording, transcript, account, or data-rights request, use the privacy/contact link on that instance's `APP_URL/privacy` page. **Never post personal data, credentials, private URLs, IDs, recordings, transcripts, or deletion requests in a public GitHub issue.**

## English

### 1. Scope

This notice covers the public source repository, project documentation and demo, release artifacts, and support/security submissions sent to the upstream maintainers.

It does not cover an operator's bot, private app, domain, storage, providers, backups, or meeting archive. That operator must publish a separate policy describing the deployment as actually configured.

### 2. What the upstream project receives

Downloading, building, or running Kassinão does not send recordings, transcripts, guild IDs, Discord credentials, MCP tokens, or instance configuration to the upstream maintainers. The application code contains no project-controlled meeting telemetry or product analytics.

The upstream project may receive information only when someone deliberately interacts with a public project service, for example:

- GitHub account information and content supplied in an issue, pull request, discussion, star, or private vulnerability report;
- npm/GitHub release download and technical request data processed by those platforms under their own policies;
- standard technical request logs processed by the hosting provider for the public website/documentation, if enabled by that infrastructure;
- correspondence and diagnostic information voluntarily sent through an approved private support or security channel.

The fictional public demo does not use a real operator workspace or meeting archive. Do not put real meeting data into a public demo, issue, pull request, or fixture.

### 3. Why and how long project information is used

Public contribution data is used to maintain the software, review changes, investigate bugs, and preserve the public project history. Public GitHub content normally remains according to GitHub and repository-history behavior.

Private vulnerability reports and private correspondence are used to investigate, coordinate, and document security work. Retention depends on the report, legal/security needs, and the platform used; the project does not promise a universal deletion schedule for third-party platform records.

GitHub, npm, domain/DNS, and hosting providers process their own service data under their policies. The Kassinão project does not control every record those providers retain.

### 4. Project requests

For a security vulnerability, use [private vulnerability reporting](https://github.com/resolvicomai/kassinao/security/advisories/new).

For correction or removal of information that **you submitted directly to the upstream project**, use the private contact method on the maintainer's GitHub profile and identify the relevant contribution without including more personal data than necessary. Some public Git history, forks, third-party caches, or platform records may not be erasable by the maintainer.

For data held by a Kassinão instance, contact that instance's operator through its privacy page. The upstream project cannot authenticate requesters for, access, or delete data from an independently operated server.

### 5. Operator policy template

Before a deployment handles Discord API data or records a real call, the operator should publish an accurate policy at `APP_URL/privacy` and register that URL under **Discord Developer Portal → General Information → Privacy Policy URL**. Replace every bracketed item below with facts from the deployed configuration; delete sections for features that are disabled.

> **Operator and scope**
>
> `[LEGAL/ORGANIZATION NAME]` operates this Kassinão instance for `[PURPOSE AND USERS]`. Contact: `[PUBLIC CONTACT URL]`. This policy applies to `[BOT NAME]`, `[APP HOST]`, and the Discord guilds authorized by this operator.
>
> **Data processed**
>
> The instance may process Discord user/account identifiers and profile names; current guild membership; voice-channel presence and historical meeting access grants; audio for accounts that speak; mixed audio; timestamps; notes; meeting/channel metadata; and web session/security records. If enabled, it also processes transcripts, AI minutes, decisions, action items, webhook deliveries, MCP tokens, and MCP query results.
>
> **Purposes and access**
>
> Data is used to record authorized calls, preserve speaker attribution by Discord stream, provide playback/downloads, enforce retention and meeting ACLs, and provide only the optional capabilities listed below. Access requires Discord login, current membership in an allowed guild, and the meeting ACL.
>
> **External services and transfers**
>
> Enabled ASR provider(s): `[NONE OR NAMES/PURPOSE/DATA SENT/REGION]`.
>
> Enabled minutes/LLM provider(s): `[NONE OR NAMES/PURPOSE/DATA SENT/REGION]`.
>
> Webhook recipient(s): `[NONE OR RECIPIENT/PURPOSE/DATA SENT]`.
>
> Backup/storage/tunnel/hosting provider(s): `[NAMES/PURPOSE/REGION]`.
>
> MCP: `[DISABLED OR EXPLAIN THAT AUTHORIZED TEXT/METADATA IS RETURNED ON REQUEST TO THE USER'S LOCAL CLIENT]`.
>
> **Retention**
>
> Audio is retained for `[RETENTION_DAYS]` days. Text, notes, minutes, and metadata are retained for `[TEXT_RETENTION_DAYS]` days. A value of `0` means manual/unlimited retention and must be described plainly. Backups/logs have these separate periods: `[PERIODS]`.
>
> **Recording notice and lawful use**
>
> The bot posts a technical notice in the voice channel's chat before capture begins. That notice is not proof of individual consent. The operator's applicable legal basis, additional notice/consent process, and auto-record rules are `[DETAILS]`.
>
> **Rights, correction, and deletion**
>
> The interface allows `[WHO]` to delete a meeting. Anyone affected may request access, correction, or deletion at `[DATA_DELETION_URL]`. The operator will authenticate requests using `[SAFE METHOD]`, respond within `[REAL PROCESS/TIMEFRAME]`, and explain any lawful limitation or backup delay. Do not submit meeting data in a public issue.
>
> **Security and incidents**
>
> Data is protected in transit by `[TLS/TUNNEL]` and at rest by `[VERIFIED LUKS/DM-CRYPT OR PROVIDER-MANAGED DISK CONTROL]`. Backups use `[CONTROL]`. Security/privacy incidents can be reported at `[CONTACT]`.
>
> **Source and changes**
>
> Corresponding Source for the running version: `[SOURCE_URL FOR THE ACTUAL VERSION/FORK]`. Policy changes are published at this URL with an updated date.

### 6. Operator launch checklist

- [ ] Publish the real operator name and a monitored public contact URL.
- [ ] Set `PRIVACY_POLICY_URL` to the public instance policy, normally `${APP_URL}/privacy`.
- [ ] Set `DATA_DELETION_URL` to an accessible request process or the policy's explicit data-rights section.
- [ ] Register `${APP_URL}/privacy` in the Discord Developer Portal.
- [ ] Describe every data category and purpose actually enabled.
- [ ] List ASR, LLM, webhook, hosting, storage, backup, tunnel, and MCP egress actually used; remove disabled features.
- [ ] Publish the real `RETENTION_DAYS`, `TEXT_RETENTION_DAYS`, log, snapshot, and backup periods.
- [ ] Document who can delete in-app and a process for any affected person to request access, correction, or deletion.
- [ ] Verify the legal notice/consent process for the relevant jurisdiction and organization; do not describe the panel as consent.
- [ ] Verify active volumes and snapshots are encrypted at rest. Container permissions and encrypted remote backups are not substitutes.
- [ ] Test the request process and policy link with an external account.
- [ ] Point `SOURCE_URL` to the Corresponding Source for the actual running version or fork.

This template is a technical checklist, not legal advice and not a claim of compliance with any law.

---

## Português (Brasil)

### 1. Escopo

Este aviso cobre o repositório público, a documentação e demo do projeto, os artefatos de release e os relatos de suporte/segurança enviados aos mantenedores do upstream.

Ele não cobre o bot, app privado, domínio, storage, providers, backups ou acervo de reuniões de um operador. Esse operador precisa publicar uma política separada que descreva o deploy como ele realmente está configurado.

### 2. O que o projeto upstream recebe

Baixar, compilar ou executar o Kassinão não envia gravações, transcrições, IDs de guild, credenciais do Discord, tokens MCP ou configuração da instância aos mantenedores upstream. O código da aplicação não contém telemetria de reunião nem analytics de produto controlado pelo projeto.

O projeto pode receber informações somente quando alguém interage de propósito com um serviço público, por exemplo:

- dados da conta GitHub e conteúdo enviado numa issue, pull request, discussão, star ou relato privado de vulnerabilidade;
- dados técnicos de requisição/download processados por npm ou GitHub conforme as políticas dessas plataformas;
- logs técnicos padrão processados pelo provedor da landing/documentação, quando habilitados nessa infraestrutura;
- correspondência e diagnósticos enviados voluntariamente por um canal privado aprovado de suporte ou segurança.

A demo pública fictícia não usa workspace nem acervo real de um operador. Não coloque dados reais de reunião em demo pública, issue, pull request ou fixture.

### 3. Finalidade e retenção de informações do projeto

Dados públicos de contribuição são usados para manter o software, revisar mudanças, investigar bugs e preservar o histórico público. Conteúdo público no GitHub normalmente permanece conforme o funcionamento do GitHub e do histórico do repositório.

Relatos privados de vulnerabilidade e correspondência privada são usados para investigar, coordenar e documentar o trabalho de segurança. A retenção depende do caso, das necessidades jurídicas/de segurança e da plataforma usada; o projeto não promete um prazo universal de exclusão para registros de terceiros.

GitHub, npm, domínio/DNS e provedores de hospedagem processam seus próprios dados de serviço sob suas políticas. O projeto Kassinão não controla todos os registros retidos por esses providers.

### 4. Pedidos ao projeto

Para vulnerabilidade, use o [relato privado de segurança](https://github.com/resolvicomai/kassinao/security/advisories/new).

Para corrigir ou remover informação que **você enviou diretamente ao projeto upstream**, use o contato privado no perfil GitHub do mantenedor e identifique a contribuição sem incluir mais dados pessoais que o necessário. Parte do histórico Git público, forks, caches de terceiros ou registros da plataforma pode não estar sob controle do mantenedor.

Para dados guardados por uma instância do Kassinão, contate o operador pela página de privacidade daquela instância. O projeto upstream não consegue autenticar solicitantes, acessar nem excluir dados de um servidor operado de forma independente.

### 5. Modelo de política do operador

Antes de o deploy processar dados da API do Discord ou gravar uma call real, o operador deve publicar uma política correta em `APP_URL/privacy` e cadastrar essa URL em **Discord Developer Portal → General Information → Privacy Policy URL**. Troque todos os campos entre colchetes pelos fatos da configuração real e remova as seções de recursos desligados.

> **Operador e escopo**
>
> `[NOME JURÍDICO/DA ORGANIZAÇÃO]` opera esta instância do Kassinão para `[FINALIDADE E PÚBLICO]`. Contato: `[URL PÚBLICA DE CONTATO]`. Esta política se aplica a `[NOME DO BOT]`, `[HOST DO APP]` e às guilds autorizadas por esse operador.
>
> **Dados processados**
>
> A instância pode processar identificadores de conta e nomes de perfil do Discord; vínculo atual com a guild; presença em canal de voz e grants históricos de acesso; áudio das contas que falam; áudio mixado; timestamps; notas; metadados de reunião/canal; e registros de sessão/segurança web. Quando habilitados, também processa transcrição, ata por IA, decisões, tarefas, entregas por webhook, tokens MCP e resultados de consultas MCP.
>
> **Finalidades e acesso**
>
> Os dados são usados para gravar calls autorizadas, preservar atribuição por stream do Discord, oferecer player/downloads, aplicar retenção e ACL da reunião e entregar somente os recursos opcionais listados abaixo. O acesso exige login Discord, vínculo atual com uma guild autorizada e ACL da reunião.
>
> **Serviços externos e transferências**
>
> Provider(s) de ASR habilitados: `[NENHUM OU NOMES/FINALIDADE/DADOS ENVIADOS/REGIÃO]`.
>
> Provider(s) de ata/LLM habilitados: `[NENHUM OU NOMES/FINALIDADE/DADOS ENVIADOS/REGIÃO]`.
>
> Destinatário(s) de webhook: `[NENHUM OU DESTINO/FINALIDADE/DADOS ENVIADOS]`.
>
> Provider(s) de backup/storage/túnel/hospedagem: `[NOMES/FINALIDADE/REGIÃO]`.
>
> MCP: `[DESLIGADO OU EXPLICAR QUE TEXTO/METADADOS AUTORIZADOS SÃO DEVOLVIDOS SOB DEMANDA AO CLIENTE LOCAL DA PESSOA]`.
>
> **Retenção**
>
> O áudio é retido por `[RETENTION_DAYS]` dias. Texto, notas, atas e metadados são retidos por `[TEXT_RETENTION_DAYS]` dias. O valor `0` significa retenção manual/ilimitada e deve ser explicado claramente. Backups/logs têm estes prazos separados: `[PRAZOS]`.
>
> **Aviso de gravação e uso legítimo**
>
> O bot publica um aviso técnico no chat do canal de voz antes da captura. Esse aviso não prova consentimento individual. A base legal aplicável, o processo adicional de aviso/consentimento e as regras de auto-record do operador são `[DETALHES]`.
>
> **Direitos, correção e exclusão**
>
> A interface permite que `[QUEM]` exclua uma reunião. Qualquer pessoa afetada pode pedir acesso, correção ou exclusão em `[DATA_DELETION_URL]`. O operador autenticará o pedido por `[MÉTODO SEGURO]`, responderá conforme `[PROCESSO/PRAZO REAL]` e explicará limitações legais ou atrasos de backup. Não envie dados de reunião em issue pública.
>
> **Segurança e incidentes**
>
> Os dados são protegidos em trânsito por `[TLS/TÚNEL]` e em repouso por `[LUKS/DM-CRYPT VERIFICADO OU CONTROLE DE DISCO DO PROVEDOR]`. Backups usam `[CONTROLE]`. Incidentes de segurança/privacidade podem ser relatados em `[CONTATO]`.
>
> **Código-fonte e mudanças**
>
> Código-Fonte Correspondente da versão em execução: `[SOURCE_URL DA VERSÃO/FORK REAL]`. Mudanças desta política são publicadas nesta URL com a data atualizada.

### 6. Checklist de lançamento do operador

- [ ] Publicar o nome real do operador e uma URL pública de contato monitorada.
- [ ] Definir `PRIVACY_POLICY_URL` para a política pública da instância, normalmente `${APP_URL}/privacy`.
- [ ] Definir `DATA_DELETION_URL` para um fluxo acessível ou para a seção explícita de direitos na política.
- [ ] Cadastrar `${APP_URL}/privacy` no Discord Developer Portal.
- [ ] Descrever todas as categorias e finalidades de dados realmente habilitadas.
- [ ] Listar ASR, LLM, webhook, hospedagem, storage, backup, túnel e egress MCP usados; remover recursos desligados.
- [ ] Publicar os valores reais de `RETENTION_DAYS`, `TEXT_RETENTION_DAYS` e os prazos de logs, snapshots e backups.
- [ ] Explicar quem apaga pela interface e oferecer a qualquer pessoa afetada um processo de acesso, correção ou exclusão.
- [ ] Verificar o processo jurídico de aviso/consentimento da jurisdição e organização; não chamar o painel de consentimento.
- [ ] Verificar criptografia em repouso dos volumes ativos e snapshots. Permissões do container e backup remoto criptografado não substituem isso.
- [ ] Testar o link da política e o pedido de dados com uma conta externa.
- [ ] Apontar `SOURCE_URL` para o Código-Fonte Correspondente da versão/fork realmente em execução.

Este modelo é um checklist técnico, não aconselhamento jurídico nem alegação de conformidade com qualquer lei.
