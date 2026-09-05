# Compromissos e fontes externas

O contexto conecta ações das atas a issues, pull requests e documentos escolhidos pelo usuário. As consultas externas são somente de leitura. Nenhum adapter cria ticket, comenta, faz merge ou envia conteúdo de reunião para Jira/GitHub.

Cada compromisso começa como **mencionado**. Pessoas com acesso à reunião podem confirmar, concluir ou cancelar explicitamente, registrando a conta que fez a alteração. Um PR incorporado continua distinto de implantação; uma issue em Done não conclui automaticamente o compromisso. Uma fonte que devolve 404 fica indisponível, nunca concluída.

## Configuração

O operador injeta a configuração no ambiente privado do core. Não coloque credenciais no repositório, em comandos compartilhados, no browser ou no MCP.

`KASSINAO_CONTEXT_SCOPES` é um array JSON de escopos explícitos:

```json
[
  {
    "guildId": "111111111111111111",
    "channelId": "222222222222222222",
    "githubRepositories": ["example/product"],
    "jira": {
      "site": "https://example.atlassian.net",
      "projects": ["PRODUCT"]
    },
    "documentOrigins": ["https://docs.google.com"]
  }
]
```

`channelId` é opcional: sua ausência aplica o mapeamento à guild inteira. Isso não concede acesso às reuniões nem às fontes externas. A lista vazia desativa os adapters para novas referências. Repositórios, projetos e origens que não constam da configuração são recusados; não há descoberta de toda a organização.

- `GITHUB_CONTEXT_TOKEN`: token de leitura com acesso somente aos repositórios selecionados e permissões Issues/Pull requests necessárias. Pode ser um token de instalação de GitHub App injetado e renovado pelo operador. Este módulo não renova tokens.
- `JIRA_CONTEXT_CREDENTIALS`: objeto JSON privado, cujas chaves são origens Jira configuradas; cada valor contém `email` e `apiToken`. Use uma conta com acesso somente aos projetos necessários. O adapter usa Basic auth nos endpoints do tenant; tokens que exigem `api.atlassian.com` não são compatíveis com este adapter.
- `KASSINAO_CONTEXT_MAX_REQUESTS`: orçamento por rodada, padrão 20, intervalo permitido 1–100. Cada rodada retoma de onde a anterior parou.

O serviço exige dois controles independentes: `authorize(userId, meetingId)` para a reunião e `authorizeArtifact(userId, reference, context)` para cada fonte, com servidor e canal da reunião. Ausência ou erro do segundo bloqueia sua exibição e vinculação. A credencial técnica do adapter não comprova acesso do destinatário. Para Jira e GitHub, o runtime exige simultaneamente o mapeamento técnico, a concessão por pessoa com expiração e uma consulta da referência exata com a credencial pessoal daquela pessoa.

No runtime do aplicativo, `KASSINAO_CONTEXT_READERS` contém concessões explícitas para destinatários, por exemplo:

```json
[
  {
    "userId": "333333333333333333",
    "expiresAt": "2026-12-31T23:59:59Z",
    "githubRepositories": ["example/product"],
    "jiraProjects": [{ "site": "https://example.atlassian.net", "projects": ["PRODUCT"] }],
    "documentOrigins": ["https://docs.google.com"]
  }
]
```

O operador só deve criar uma concessão após confirmar o acesso daquela pessoa na origem. Expiração é checada em cada leitura. Alterações nas variáveis exigem recarregar o runtime pelo procedimento normal de deploy; editar o arquivo de ambiente não altera o processo já iniciado. Uma concessão de fonte não substitui o acesso atual à reunião.

`KASSINAO_CONTEXT_USER_CREDENTIALS` é outro objeto JSON, mantido somente no ambiente privado do core. Cada chave é a conta Discord do destinatário; os tokens devem pertencer à pessoa correspondente:

```json
{
  "333333333333333333": {
    "githubToken": "TOKEN_PESSOAL_DE_LEITURA",
    "jira": {
      "https://example.atlassian.net": {
        "email": "pessoa@example.com",
        "apiToken": "TOKEN_JIRA_DA_PESSOA"
      }
    }
  }
}
```

Sem credencial pessoal, o vínculo Jira/GitHub não é exibido nem aceito. O verificador faz somente GET da issue ou PR exata, sem redirecionar e sem enviar texto de reunião. A conta técnica nunca é usada como alternativa. Respostas 401, 403 e 404 ocultam a fonte; timeout, rate limit e resposta inválida indicam indisponibilidade temporária em vez de fingir acesso confirmado ou lista vazia. O corpo fica limitado a 128 KiB.

Consultas repetidas à mesma referência são reaproveitadas somente dentro da operação atual. A próxima leitura ou preparação de informativo consulta a origem novamente, de modo que revogar o token ou o acesso na origem bloqueia a operação seguinte. Cada operação admite até 100 referências distintas e tem orçamento total de 10 segundos; exceder o orçamento deixa a leitura parcial, com `sourceAccessIncomplete` e fontes não confirmadas ocultas. Mutações continuam recusadas quando falta confirmação. Itens com consulta incompleta não são reconhecidos no informativo; rodadas seguintes alternam os combinados seguidos para alcançar o restante do acervo. Tokens não são persistidos no estado dos compromissos, devolvidos pela API nem incluídos em logs.

O diagnóstico mostrado à própria pessoa distingue configuração, concessão ausente ou vencida, credencial pessoal ausente e resultado da última consulta de uma fonte. Configurado não significa verificado. Uma consulta bem-sucedida não comprova acesso a todos os projetos nem validade futura; seu horário continua histórico quando a concessão expira. Os horários de último sucesso e última falha, com categoria sanitizada, são mantidos apenas em memória durante o runtime atual. Não incluem URLs, repositórios, tenants, emails, tokens ou respostas do provider. Documentos manuais não geram sucesso de consulta nesse diagnóstico.

Para recuperar acesso, o painel orienta pedir ao operador a configuração ou a concessão faltante, renovar uma concessão vencida ou conectar a credencial pessoal pelo procedimento privado existente. Em 401/403, a origem recusou a credencial **ou o acesso à fonte**; isso não prova, sozinho, que o token expirou. Em 404, confirme o link e o acesso na origem. Timeout, limite de consultas e falhas temporárias pedem nova tentativa. Possuir uma credencial Jira para um tenant não cobre os outros tenants da pessoa. Nenhuma dessas mensagens habilita fallback para a conta técnica, coleta tokens no navegador ou cria um fluxo OAuth novo.

Documentos continuam apenas como links manuais por concessão e origem autorizada. Não há consulta de conteúdo nem confirmação genérica de acesso documental com esse mapeamento; esses links não devem ser apresentados como leitura verificada.

## Referências e resultados

Aceita links exatos `github.com/owner/repo/issues/N`, `github.com/owner/repo/pull/N` e `tenant.atlassian.net/browse/PROJECT-N`. Também aceita `owner/repo#N` como issue e `PROJECT-N` quando existe apenas um tenant autorizado para esse projeto. Links da API GitHub são normalizados para os links públicos equivalentes. Documentos são links manuais de origens autorizadas; seu conteúdo não é consultado.

O adapter permite somente GET para `api.github.com` e o tenant Jira configurado. URLs remotas são construídas a partir dos identificadores validados; redirecionamentos, credenciais em URL, portas alternativas, parâmetros arbitrários e origens não autorizadas são recusados. A resposta tem teto de 128 KiB e prazo total de 10 segundos, incluindo leitura do corpo. Falhas registram uma categoria sanitizada; textos de erros externos e credenciais não são persistidos.

O snapshot guarda título limitado, estado, última atualização informada pela fonte e horário da consulta. Seu campo `deployed` permanece `null`: este adapter não consulta ambientes nem pipelines de implantação. Estado indisponível e rate limit aparecem como ausência de confirmação, preservando o compromisso.

## Preferências e informativos

O padrão é não seguir. **Seguir** autoriza incluir o compromisso nos informativos daquele usuário; **silenciar** o exclui e **adiar** pausa até o instante escolhido. As preferências são independentes entre pessoas.

`prepareDigest` retorna somente diferenças de compromissos seguidos e autorizados. A preparação não grava confirmação. O chamador deve revalidar acesso e preferência imediatamente antes da entrega, enviar o resultado e só então chamar `acknowledgeDigest`. Falha de envio mantém a diferença pendente. A API de confirmação não considera reconhecida uma alteração que ocorreu depois da preparação. Como APIs de mensagem podem confirmar recebimento depois de um timeout, entrega externa exatamente uma vez não é garantida; o consumidor precisa tratar a resposta incerta.

Após a confirmação de envio, `lastNotice` preserva por compromisso e destinatário o motivo e o horário do aviso, para que a página possa explicar a mudança. Esse registro comprova confirmação de envio pelo chamador, não leitura humana.

Prazos relativos usam a data/fuso da reunião. A transição para hoje e depois vencido gera uma diferença, sem repetir a cobrança diariamente. Prazo ambíguo permanece sem classificação. Concluir/cancelar explicitamente encerra os alertas de vencimento, preservando o histórico.

## Estado e operação

O arquivo `STATE_DIR/commitments.json` recusa crescimento acima de 32 MiB antes da escrita, preservando o acervo anterior. A limpeza ainda pode reduzir um arquivo legado de até 128 MiB. Usa escrita atômica com modo 0600, seguindo o mesmo contrato dos demais estados do aplicativo. Contém compromissos, referências, snapshots mínimos e preferências; não contém tokens. Os callbacks de exclusão e retenção devem chamar `removeMeeting`, e a reconciliação do acervo no boot deve chamar `removeMissingMeetings`.

Não misture remoção do áudio com remoção da reunião: os compromissos podem continuar úteis durante a retenção do texto. Quando a reunião inteira expira, compromisso, vínculos e preferências correspondentes são removidos juntos. Backups seguem a política independente do operador.

Validação automatizada cobre fontes em estados distintos, bloqueios de origem/acesso, respostas limitadas, timeout, persistência, expiração de prazo, deduplicação de informativos, mutações explícitas e preservação de vínculos que o usuário não pode visualizar.

## Referências oficiais

- [GitHub: consultar pull requests](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request).
- [GitHub: consultar issues](https://docs.github.com/en/rest/issues/issues#get-an-issue).
- [GitHub: permissões e operação de Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).
- [Jira Cloud: API de issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).
- [Jira Cloud: autenticação por token](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/).

## Uso no aplicativo

Em **Combinados**, selecione o estado, vincule as fontes visíveis e escolha **Receber avisos por DM**. A pausa dura sete dias; silenciar interrompe os avisos até nova adesão. Após a confirmação de envio, o painel mantém o motivo e o horário da última mudança avisada.

**Acompanhamento automático por canal** pode ser ativado antes de existir uma ata. A pessoa escolhe incluir pendências anteriores ou somente as próximas atas; concluídos antigos ficam fora do primeiro informativo. A pessoa continua precisando de acesso a cada reunião; assinar o canal não concede permissão. Uma escolha individual de seguir, silenciar ou adiar prevalece sobre a assinatura. Desativar a assinatura interrompe apenas o acompanhamento herdado; itens seguidos individualmente preservam a escolha.

Para reunir menções do mesmo combinado em calls diferentes, confirme a associação na página. A interface apresenta um cartão com as menções que aquela pessoa pode consultar. Os registros continuam separados para respeitar exclusão e acesso, e a associação pode ser desfeita. Alterar o estado ou as preferências das demais menções exige marcar a opção de aplicar ao grupo; o servidor verifica todos os itens antes de salvar qualquer alteração. O histórico preserva até 50 mudanças por registro, com conta, horário e valores anteriores e novos, ocultando fontes e menções inacessíveis.

URLs e códigos exatos citados na tarefa ou na fala de origem aparecem como sugestões para confirmação. Não há correspondência por nome parecido. Referências gerais da reunião não são atribuídas automaticamente a uma tarefa. A extração tem limites de texto e quantidade; ela não consulta o conteúdo dos documentos.

**Como confirmar a conclusão** permite escolher confirmação manual, uma issue Jira em Done ou um PR integrado. O critério de fonte deve corresponder ao combinado: merge continua sem comprovar deploy. Ao aplicar o critério às outras menções, o vínculo exato é copiado somente após autorização da reunião, do projeto/canal e da fonte em todos os registros. Uma leitura de até 60 minutos que satisfaça o critério produz `effectiveCompletion`, sem alterar o estado manual. Leitura antiga, falha ou fonte sem acesso deixa a conclusão desconhecida e não gera cobrança de atraso baseada nesse critério. O MCP retorna a evidência e o critério visíveis separadamente do estado manual.

**Foi útil / Dispensável** registra a avaliação da pessoa; não encerra nem silencia o combinado. O painel de operação agrega essas avaliações, durações persistidas por etapa e blocos reaproveitados. Campos sem medição aparecem como desconhecidos. Tarefa, responsável e prazo podem ser corrigidos pela pessoa sem regerar a ata. A extração anterior e o histórico permanecem registrados; não há associação automática de pessoas por semelhança de nome entre ferramentas.

O monitor consulta fontes a cada 15 minutos. As DMs contêm um aviso genérico e o link privado do item ou lote alterado; o conteúdo só é exibido após nova verificação de acesso. Eventos agendados do Discord podem gerar um lembrete nos 30 minutos anteriores, para quem acompanha itens abertos ou assinou aquele canal. Mudanças de horário/canal e cancelamento de um evento já avisado são acompanhados; passar do horário não é interpretado como cancelamento. Sem evento agendado, não há previsão de reunião. Até cinco servidores são consultados por leitura, com indicação de consulta parcial no painel quando necessário.

**Revisão e correção:** menção da ata não vira obrigação vencida antes de confirmação humana. Alteração material e cobertura parcial suspendem a confirmação da versão atual até a pessoa marcar que conferiu. O estado anterior permanece no histórico. Reprocessar não transfere conclusão entre tarefas repetidas pela ordem e não sobrescreve correções humanas silenciosamente.

**Decisão posterior:** no detalhe de um combinado, escolha uma reunião acessível e uma decisão com fala de origem. Confira o trecho e escolha cancelar ou substituir. O servidor confere a versão do combinado e da decisão exibida, o acesso às duas reuniões e a presença literal da fala na transcrição. Não é necessário inventar uma nova tarefa para registrar uma decisão que apenas encerra a anterior.

Formulários compartilhados usam revisões autenticadas; se algo mudou desde a abertura, o servidor responde com conflito e um link para conferir a versão atual. Quem gerencia a gravação pode reparar dependências cujo acesso foi perdido: as fontes ocultas não são exibidas e falha temporária não autoriza remoção. Uma fonte aberta que diverge de conclusão manual é destacada, sem reescrever a decisão humana automaticamente.

**Entrega dos meus avisos** diferencia envio aceito pelo Discord, bloqueio, tentativa pendente e resultado incerto. Aceite de envio não significa leitura pela pessoa. O monitor evita sobrepor um envio ainda sem resultado; a página informa quando uma nova tentativa poderá ocorrer. Reinício e respostas perdidas não constituem garantia de entrega exatamente uma vez.

Documentos vinculados recebem o rótulo **acesso ao documento não verificado**. O formulário informa que leitores autorizados do combinado poderão ver o vínculo e pede conferir se o endereço concede acesso ao documento.

A tela da gravação mostra a fala de origem conferida, permite editar o título e oferece nova tentativa de ata após falha definitiva, reutilizando a transcrição. Essa nova tentativa usa o provedor configurado e pode consumir sua cota. O resultado aparece na própria página; o fluxo não reenvia automaticamente todas as notificações históricas.

Em **Conectar IA**, conexões novas permitem escolher canal, datas, conteúdo e validade de 7, 30 ou 90 dias. O padrão é somente ata. Sessões existentes preservam o escopo anterior. O horário de leitura confirmada é separado do refresh da credencial. Em **Operação**, o dono da instância consulta fila, falhas, duração observada, espaço livre e registros de backup; o painel não comprova restauração nem concilia faturas.

## Recuperação e exclusão

O processamento guarda blocos concluídos para retomar sem repetir o trabalho já salvo. Requisições aos provedores têm prazo total e limite de corpo. Os jobs AssemblyAI cujo ID foi recebido entram em uma fila privada de exclusão retomável; jobs antigos e IDs de respostas nunca recebidas não são descobertos automaticamente.

`MINUTES_WEBHOOK_GUILD_IDS` e `MINUTES_WEBHOOK_CHANNEL_IDS` limitam a entrega existente. `MINUTES_WEBHOOK_PAYLOAD` seleciona `metadata`, `minutes` ou `transcript`; o modo `minutes` não inclui citações literais da transcrição. Listas vazias preservam o alcance anterior, portanto devem ser preenchidas ao autorizar um destino novo. HTTP 2xx comprova recebimento HTTP, não processamento do destino.

Antes de excluir áudio ou gravação, o app registra a intenção em `STATE_DIR/deletion-ledger.json`. Uma restauração deve obrigatoriamente ser reconciliada com o ledger **mais recente**, preservado fora do snapshot antigo. Antes de recuperar processamento ou abrir o servidor web, o boot recusa iniciar se esse ledger ainda aponta gravação ou áudio restaurado presente; ele não apaga a restauração automaticamente. Um ledger ausente ou antigo não permite descobrir exclusões que só constavam da versão mais recente, por isso esse bloqueio não substitui a preservação e conferência do ledger atual. O comando abaixo apenas simula; `--apply` remove conteúdo da árvore restaurada e exige autorização operacional:

```sh
node scripts/reconcile-restored-deletions.cjs --ledger /caminho/do/ledger-atual.json --recordings-dir /caminho/da/restauracao-offline
```

O comando não acessa backups remotos nem muda a retenção. Remoção do acervo ativo e exclusão de cópias históricas são operações distintas. Use o procedimento de restauração antes de reabrir o serviço.
