# Recuperação, exclusão e webhooks de ata

Procedimentos de operação da instância: retomada de processamento, entrega de webhooks
e reconciliação obrigatória do ledger de exclusão depois de uma restauração.

O processamento guarda blocos concluídos para retomar sem repetir o trabalho já salvo. Requisições aos provedores têm prazo total e limite de corpo. Os jobs AssemblyAI cujo ID foi recebido entram em uma fila privada de exclusão retomável; jobs antigos e IDs de respostas nunca recebidas não são descobertos automaticamente.

`MINUTES_WEBHOOK_GUILD_IDS` e `MINUTES_WEBHOOK_CHANNEL_IDS` limitam a entrega existente. `MINUTES_WEBHOOK_PAYLOAD` seleciona `metadata`, `minutes` ou `transcript`; o modo `minutes` não inclui citações literais da transcrição. Listas vazias preservam o alcance anterior, portanto devem ser preenchidas ao autorizar um destino novo. HTTP 2xx comprova recebimento HTTP, não processamento do destino.

Antes de excluir áudio ou gravação, o app registra a intenção em `STATE_DIR/deletion-ledger.json`. Uma restauração deve obrigatoriamente ser reconciliada com o ledger **mais recente**, preservado fora do snapshot antigo. Antes de recuperar processamento ou abrir o servidor web, o boot recusa iniciar se esse ledger ainda aponta gravação ou áudio restaurado presente; ele não apaga a restauração automaticamente. Um ledger ausente ou antigo não permite descobrir exclusões que só constavam da versão mais recente, por isso esse bloqueio não substitui a preservação e conferência do ledger atual. O comando abaixo apenas simula; `--apply` remove conteúdo da árvore restaurada e exige autorização operacional:

```sh
node scripts/reconcile-restored-deletions.cjs --ledger /caminho/do/ledger-atual.json --recordings-dir /caminho/da/restauracao-offline
```

O comando não acessa backups remotos nem muda a retenção. Remoção do acervo ativo e exclusão de cópias históricas são operações distintas. Use o procedimento de restauração antes de reabrir o serviço.
