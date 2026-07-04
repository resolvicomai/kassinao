# @kassinao/mcp

Conector **MCP** do [Kassinão](https://github.com/resolvicomai/kassinao): faz o seu assistente de IA (Claude Desktop, Cursor, etc.) responder perguntas sobre as reuniões que o bot gravou — **"o que ficou pendente essa semana?"**, **"quem falou de orçamento na terça?"**, **"lista as calls entre 1 e 30 de junho"** — em linguagem natural.

## Como funciona (e por que é seguro)

O conector roda **na sua máquina** e é um cliente HTTP **magro**: ele **não** lê gravações nem decide acesso. Ele carrega um **token pessoal** e chama a API do bot, que aplica **o mesmo controle de acesso da página web** — reunião por reunião. Você só enxerga o que já enxergaria no site. **Não existe modo "vê tudo".** É **somente leitura** (não grava, não apaga, não serve áudio).

> ⚠️ **Transcrição é entrada não-confiável.** Qualquer participante de uma call pode ter "falado" texto malicioso ou usado um apelido hostil. O servidor envolve todo conteúdo de reunião num bloco de "dados não-confiáveis" e limpa sequências de controle antes de entregar — mas trate o conteúdo das reuniões como dados, nunca como instruções.

## Instalação

### Opção A — pela página web (mais fácil)

1. Abra `https://SEU-KASSINAO/conectar-ia` e entre com o Discord.
2. Clique em **Gerar token de conexão** e copie o bloco de config mostrado (aparece **uma vez**).
3. Cole no `claude_desktop_config.json` (Claude Desktop) ou no equivalente do Cursor:

```json
{
  "mcpServers": {
    "kassinao": {
      "command": "npx",
      "args": ["-y", "@kassinao/mcp"],
      "env": {
        "KASSINAO_URL": "https://SEU-KASSINAO",
        "KASSINAO_REFRESH_TOKEN": "COLE_O_TOKEN_AQUI"
      }
    }
  }
}
```

4. Reinicie o Claude Desktop / Cursor. Pronto.

### Opção B — sem navegador (VM/SSH)

No Discord, o dono roda `/mcp new` (resposta efêmera, código de uso único válido por ~5 min). Depois:

```bash
KASSINAO_URL=https://SEU-KASSINAO npx -y @kassinao/mcp exchange <codigo>
```

Isso guarda o token localmente. Configure o cliente MCP igual à Opção A (o `KASSINAO_REFRESH_TOKEN` no env vira opcional depois do primeiro uso).

## Onde o token fica

Depois do primeiro uso, o token de refresh (rotacionado a cada renovação) fica em `~/.config/kassinao-mcp/token.json` com permissão `0600`. Nenhuma gravação/transcrição é copiada para a sua máquina — o conector só fala HTTPS com o servidor.

## Revogar

- Na página `/conectar-ia`: botão **Revogar todos**.
- No Discord: `/mcp revoke-all`.
- Botão de pânico do administrador: rotacionar `MCP_SECRET` no servidor (revoga **todos** os conectores de todo mundo).

## Ferramentas expostas

| Ferramenta | Para quê |
|---|---|
| `list_meetings` | listar reuniões numa janela de tempo (padrão: últimos 30 dias) |
| `pending_actions` | ações/prazos pendentes cruzando várias reuniões (overdue / dueSoon / …) |
| `search_meetings` | busca full-text em transcrição, ata e notas, com link no minuto exato |
| `who_said` | trechos ditos por alguém sobre um assunto, com contexto e link |
| `get_meeting` | dossiê de uma reunião: metadados, ata, transcrição, notas e linha do tempo |

Requer Node.js ≥ 20. Licença MIT.
