# kassinao-mcp

Local stdio connector for querying meeting data that your account is already allowed to access in a self-hosted [Kassinão](https://github.com/resolvicomai/kassinao) instance.

[Português](#português-brasil) · [Project documentation](https://docs.kassinao.cloud/en#mcp) · [npm package](https://www.npmjs.com/package/kassinao-mcp)

## English

### Boundary and access

`kassinao-mcp` is a local MCP server and HTTPS client. It runs on your computer, receives tool calls over stdio, and requests authorized text/metadata from the `KASSINAO_URL` of your operator's instance.

It does not mount or scan Kassinão server files, decide access locally, download an archive, serve audio, write meeting data, or fall back to an upstream hosted API. `KASSINAO_URL` is mandatory and must identify the instance that issued the token.

The server rechecks current Discord membership and the meeting ACL for every request. A URL or local profile name is not a credential. There is no “see everything” mode.

Speaker labels come from the Discord account/stream captured during the call. They are useful source labels, not biometric identification or proof of a person's real-world identity.

This version exposes five read-only tools:

| Tool | Result |
| --- | --- |
| `list_meetings` | Authorized meetings in a time window |
| `pending_actions` | Authorized pending/overdue action items |
| `search_meetings` | Bounded search over transcripts, minutes, and notes, with cursors/source links |
| `who_said` | Matching attributed excerpts with context/source links |
| `get_meeting` | Authorized meeting metadata and available text artifacts |

The connector is intended for MCP hosts that support a local stdio server configuration. Compatibility depends on the host and version; do not assume every MCP client implements the same configuration or behavior.

Meeting content is untrusted input. A participant can speak malicious text or use a hostile display name. The connector labels returned content as data and the server neutralizes common formatting/control sequences, but the MCP host and model must still treat every transcript, note, name, and minute as data rather than instructions.

### Requirements

- Node.js 20+ on the user's computer.
- `MCP_SECRET` enabled by the instance operator.
- An account that can sign in to the private app and access at least one allowed guild.
- HTTPS for a non-local `KASSINAO_URL`.

### Create a personal connection

1. Open `APP_URL/app/conectar-ia` on your operator's instance and sign in with Discord.
2. Generate a named connection and copy the single-use code.
3. Run the exact exchange command shown by the page. It follows this form:

   ```bash
   npx -y kassinao-mcp@1.0.11 exchange --stdin --url https://mcp.your-instance.example
   ```

4. Paste the code into the hidden prompt. The command stores a rotating refresh token outside the MCP host configuration and prints a block containing a non-secret `KASSINAO_PROFILE` selector.
5. Add that printed block to a compatible local-stdio MCP host and restart the host if its documentation requires it.

Example shape (use the values printed by your instance, not these placeholders):

```json
{
  "mcpServers": {
    "kassinao": {
      "command": "npx",
      "args": ["-y", "kassinao-mcp@1.0.11"],
      "env": {
        "KASSINAO_URL": "https://mcp.your-instance.example",
        "KASSINAO_PROFILE": "PROFILE_PRINTED_BY_THE_EXCHANGE"
      }
    }
  }
}
```

For a browserless operator flow, a Discord ID listed in `OWNER_IDS` can run `/mcp new` (`/mcp novo` in pt-BR) and exchange the one-time code with the same command. That command is administrative; regular members use the self-service private app.

### Local token storage

Connections are isolated by profile under `~/.config/kassinao-mcp/`. On macOS/Linux, the directory is forced to mode `0700` and token files to `0600`; on Windows, they use the current profile's inherited ACL. The refresh token rotates and is never printed into the MCP host configuration.

Do not copy one profile/token to another person or instance. A domain/origin migration requires a new connection issued by the new URL; changing only `KASSINAO_URL` does not migrate a token.

### Revoke

- Revoke one connection or all personal connections at `APP_URL/app/conectar-ia`.
- An operator listed in `OWNER_IDS` can use `/mcp revoke-all` (`/mcp revogar-tudo`).
- Rotating the instance's `MCP_SECRET` invalidates every MCP connection and is an operator-wide emergency action.

### Run from source

```bash
git clone https://github.com/resolvicomai/kassinao.git
cd kassinao/mcp
npm ci --userconfig ../.npmrc.security
npm run build
node dist/index.js
```

For a local host config, replace `npx` with `node` and point its args to the absolute `mcp/dist/index.js` path.

---

## Português (Brasil)

### Limite e acesso

`kassinao-mcp` é um servidor MCP local e cliente HTTPS. Ele roda no seu computador, recebe chamadas de tools por stdio e solicita texto/metadados autorizados ao `KASSINAO_URL` da instância do seu operador.

Ele não monta nem varre arquivos do servidor Kassinão, não decide acesso localmente, não baixa um acervo, não serve áudio, não altera reuniões e não usa uma API hospedada do upstream como fallback. `KASSINAO_URL` é obrigatório e deve identificar a instância que emitiu o token.

O servidor revalida o vínculo atual com o Discord e a ACL da reunião em cada requisição. URL e nome de perfil local não são credenciais. Não existe modo “ver tudo”.

Os rótulos de fala vêm da conta/stream do Discord capturada durante a call. Eles servem como rótulos de origem, não como identificação biométrica nem prova da identidade real de uma pessoa.

Esta versão expõe cinco tools read-only:

| Tool | Resultado |
| --- | --- |
| `list_meetings` | Reuniões autorizadas numa janela de tempo |
| `pending_actions` | Tarefas pendentes/atrasadas de reuniões autorizadas |
| `search_meetings` | Busca limitada em transcrições, atas e notas, com cursores/links de fonte |
| `who_said` | Trechos atribuídos com contexto/links de fonte |
| `get_meeting` | Metadados e artefatos textuais disponíveis de uma reunião autorizada |

O conector é destinado a hosts MCP que aceitam configuração de servidor stdio local. A compatibilidade depende do host e da versão; não presuma que todo cliente MCP implemente a mesma configuração ou comportamento.

Conteúdo de reunião é entrada não confiável. Uma pessoa pode falar texto malicioso ou usar um nome hostil. O conector marca as respostas como dados e o servidor neutraliza sequências comuns de controle/formatação, mas o host e o modelo ainda precisam tratar transcrições, notas, nomes e atas como dados, nunca como instruções.

### Requisitos

- Node.js 20+ no computador da pessoa.
- `MCP_SECRET` habilitado pelo operador da instância.
- Conta capaz de entrar no app privado e acessar ao menos uma guild permitida.
- HTTPS num `KASSINAO_URL` que não seja local.

### Criar uma conexão pessoal

1. Abra `APP_URL/app/conectar-ia` na instância do operador e entre com Discord.
2. Gere uma conexão nomeada e copie o código de uso único.
3. Rode o comando exato mostrado pela página. Ele segue este formato:

   ```bash
   npx -y kassinao-mcp@1.0.11 exchange --stdin --url https://mcp.sua-instancia.example
   ```

4. Cole o código no prompt oculto. O comando guarda um refresh token rotativo fora da configuração do host e imprime um bloco com o seletor não secreto `KASSINAO_PROFILE`.
5. Adicione o bloco impresso a um host MCP compatível com stdio local e reinicie o host quando a documentação dele exigir.

Formato do exemplo (use os valores impressos pela sua instância, não estes placeholders):

```json
{
  "mcpServers": {
    "kassinao": {
      "command": "npx",
      "args": ["-y", "kassinao-mcp@1.0.11"],
      "env": {
        "KASSINAO_URL": "https://mcp.sua-instancia.example",
        "KASSINAO_PROFILE": "PERFIL_IMPRESSO_NA_TROCA"
      }
    }
  }
}
```

Para um fluxo administrativo sem navegador, um ID listado em `OWNER_IDS` pode usar `/mcp novo` (`/mcp new` em inglês) e trocar o código descartável pelo mesmo comando. Esse comando é administrativo; participantes comuns usam o self-service do app privado.

### Armazenamento local do token

As conexões ficam isoladas por perfil em `~/.config/kassinao-mcp/`. No macOS/Linux, o diretório usa modo `0700` e os arquivos de token `0600`; no Windows, valem as ACLs herdadas pelo perfil atual. O refresh token gira e nunca é impresso na configuração do host MCP.

Não copie um perfil/token para outra pessoa ou instância. Uma migração de domínio/origem exige nova conexão emitida pela nova URL; trocar apenas `KASSINAO_URL` não migra o token.

### Revogar

- Revogue uma conexão ou todas as conexões pessoais em `APP_URL/app/conectar-ia`.
- Um operador listado em `OWNER_IDS` pode usar `/mcp revogar-tudo` (`/mcp revoke-all`).
- Girar `MCP_SECRET` invalida todas as conexões MCP da instância e é uma ação emergencial global do operador.

### Rodar pelo código-fonte

```bash
git clone https://github.com/resolvicomai/kassinao.git
cd kassinao/mcp
npm ci --userconfig ../.npmrc.security
npm run build
node dist/index.js
```

Numa configuração local, troque `npx` por `node` e aponte os argumentos para o caminho absoluto de `mcp/dist/index.js`.

License / Licença: AGPL-3.0-or-later.
