# Broker persistente + multi-deck para o figma-slides-mcp

Data: 2026-08-11
Status: aprovado, pronto para plano de implementação

## Problema

Hoje o servidor WebSocket vive **dentro** do processo MCP (`mcp/src/mcp-server.ts`). Isso produz duas falhas distintas com a mesma raiz:

1. **A conexão morre quando o processo MCP reinicia.** `startWebSocketServer()` faz o bind em `:3055` e, se não conseguir dentro de 5s, chama `process.exit(1)` (`mcp-server.ts:112`). O cliente MCP marca o servidor como falho e não o revive — a sessão fica com um MCP morto e a única saída é reiniciar tudo.
2. **Só dá para trabalhar em um deck por vez.** Existe uma única variável `figmaSocket` (`mcp-server.ts:15`); cada nova conexão sobrescreve a anterior. Além disso, `killStaleProcess()` (`mcp-server.ts:21-39`) mata qualquer outro `mcp-server` na porta, então duas sessões do Claude Code se derrubam mutuamente.

Verificado empiricamente: **duas instâncias do plugin em dois arquivos de Slides coexistem** — ambas conectam. Falta apenas o roteamento.

## Restrições (verificadas)

- **`figma.fileKey` é inacessível.** Exige plugin privado de organização com `enablePrivatePluginApi`. Não serve como identificador de deck.
- **`figma.root.id` não é confiável como identificador global.** Ids de nó do Figma têm a forma `<sessão>:<local>` e o root tende a ser `0:0` em todo arquivo — provável colisão entre decks. O design não depende dele.
- **O Figma é dono do ciclo de vida do plugin.** A documentação é explícita que plugins não rodam em background, e o runtime do iframe pode ser destruído pelo Figma sem que keepalive algum previna. Consequência aceita: **o primeiro start do plugin em cada deck permanece manual.** O escopo deste trabalho é garantir que reiniciar o cliente MCP nunca mais quebre a ponte, não eliminar toda interação com o Figma.
- **Timers em iframe oculto sofrem throttling.** A UI do plugin é criada com `visible: false` (`figma-plugin/code.ts:5`), então o `setInterval` de 3s de reconexão em `ui.html:58` é candidato forte a estrangulamento. O relógio de reconexão precisa sair do iframe.

## Não-objetivos

- Reabrir o plugin automaticamente via AppleScript. Avaliado e descartado do núcleo: exige permissão de Acessibilidade, quebra a cada mudança de menu do Figma, é só macOS e atua na janela em foco — com dois decks abertos, pode reabrir no arquivo errado. Pode virar camada opcional depois.
- Roteamento automático por foco do Figma. Rejeitado explicitamente: um comando de edição indo para o deck errado é um estrago silencioso e difícil de desfazer.
- Eventos empurrados do Figma para o agente (reagir a seleção de slide, etc.). Fora de escopo.

## Arquitetura

| Peça | Papel | Estado |
|---|---|---|
| `mcp/src/broker.ts` → `dist/broker.mjs` | Daemon dono da `:3055`. Registra conexões e encaminha envelopes. | novo |
| `mcp/src/mcp-server.ts` | Deixa de ser servidor WS; vira **cliente** do broker. Detém a lógica de seleção de alvo. | transporte reescrito |
| `mcp/figma-plugin/ui.html` | Conecta ao broker, envia `hello`, reconecta. | `hello` + reconexão |
| `mcp/figma-plugin/code.ts` | Fornece `figma.root.name`, dirige o heartbeat de reconexão. | adições pontuais |

`mcp/build.mjs` ganha uma terceira entrada para `broker.ts`, espelhando a configuração de `serverBuild` (mesmo banner, `platform: "node"`, `format: "esm"`, sourcemap) e incluída tanto no caminho de build quanto no de `--watch`. `package.json` → `files` já cobre `mcp/dist/`, então o broker é publicado junto sem mudança.

`.mcp.json` **não muda**: o comando registrado continua `node mcp/dist/mcp-server.mjs`.

### Princípio: o broker é burro

O broker não sabe o que é um slide, não interpreta comando e não escolhe alvo. Ele mantém um registro de conexões e encaminha envelopes. Toda a inteligência de seleção fica no servidor MCP.

Isso é o que garante que ambiguidade **suba** até o agente em vez de ser resolvida por um chute na camada de transporte.

## Identidade do deck

- **Chave de roteamento** — `connId`: UUID gerado pelo broker por conexão. Efêmero, único, sem dependência de API do Figma.
- **Rótulo de seleção** — `docName`: `figma.root.name`, o nome do arquivo. É por ele que o usuário e o agente se referem ao deck ("o deck de vendas").

Nada é escrito no arquivo do Figma (sem `setPluginData`). Decks com nome idêntico se desempatam pelo `connId`, que aparece na listagem.

Consequência aceita: o `connId` muda quando o plugin é relançado, então um alvo fixado se perde no relaunch. A recuperação é `use_deck` com o nome, que é estável.

## Protocolo

JSON sobre WebSocket, um envelope. `protocol: 1` em todo `hello`.

**Plugin → broker**, ao conectar:
```json
{ "type": "hello", "role": "plugin", "docName": "Deck de Vendas", "editorType": "slides", "protocol": 1 }
```

**Servidor MCP → broker**, ao conectar:
```json
{ "type": "hello", "role": "controller", "protocol": 1 }
```

**Controlador → broker**, comando endereçado:
```json
{ "type": "command", "id": "req_1", "target": "<connId>", "command": "execute", "params": { "code": "..." } }
```

O broker guarda `id → controlador de origem`, encaminha ao plugin alvo preservando o `id`, e devolve a resposta **apenas** ao controlador que originou. Duas sessões do Claude Code nunca veem o tráfego uma da outra.

**Broker → controlador**, empurrado a cada entrada/saída de plugin e também na conexão inicial:
```json
{ "type": "targets", "targets": [{ "connId": "a3f1...", "docName": "Deck de Vendas", "editorType": "slides" }] }
```

O controlador mantém essa lista em memória; `list_decks` não faz round-trip.

**Erros de comando originados no broker**, devolvidos ao controlador que originou, com o `id` original:
- `no_such_target` — `connId` desconhecido.
- `target_disconnected` — o plugin caiu entre o envio e a entrega.

**Erro de handshake**, fora do fluxo de comandos (o `hello` não tem `id`): `protocol_mismatch`, enviado como `{ "type": "error", "code": "protocol_mismatch", "brokerProtocol": 1 }` antes de o broker fechar a conexão.

## Superfície MCP

Duas ferramentas novas; duas existentes ganham um parâmetro opcional.

- `list_decks()` → decks conectados: `connId`, `docName`, `isPinned`.
- `use_deck({ deck })` → fixa o alvo da sessão. Aceita `connId` completo ou trecho do `docName`. Se o trecho casar com mais de um, erro com candidatos.
- `execute({ code, deck? })` — `deck` opcional, sobrepõe o fixado.
- `screenshot_slide({ slideIndex, scale?, deck? })` — idem.

### Resolução de alvo

Ordem, por chamada:

1. Parâmetro `deck` explícito.
2. Alvo fixado na sessão (via `use_deck`), se ainda conectado.
3. Se há exatamente **um** deck conectado, usa ele.
4. Caso contrário, **erro com os candidatos** — a ferramenta não age.

```
Ambiguous target: 2 decks connected. Pass `deck` or call use_deck first.
  - "Deck de Vendas"   (a3f1)
  - "Deck de Produto"  (b7c2)
```

O ramo 4 é o que implementa "se não souber, confirmar" como garantia estrutural em vez de disciplina do agente: com dois decks e nenhuma pista, a ferramenta se recusa a agir e devolve os nomes, e o agente casa com o contexto da conversa ou pergunta ao usuário. O ramo 3 preserva o fluxo atual — com um deck só, nada muda para o usuário.

Se nenhum deck estiver conectado, o erro mantém a instrução de hoje (`mcp-server.ts:125`): abrir o plugin "Claude Code Slides" em Plugins > Development.

## Ciclo de vida e reconexão

**Broker**
- Ping a cada 20s para todo cliente; derruba quem perder 2 pongs consecutivos. Isso reapa conexão zumbi — hoje o servidor pode ver `readyState === OPEN` enquanto os comandos caem no vazio até estourar o timeout de 15s.
- Desligamento por ociosidade: sem nenhum cliente por 30 min, encerra. Evita processo órfão permanente.
- Ao perder o bind (`EADDRINUSE`), **sai com código 0, em silêncio** — outro broker venceu a corrida e é isso mesmo.

**Servidor MCP → broker**
- Tenta conectar em `ws://localhost:3055`. Se recusar, sobe `broker.mjs` *detached*, com `stdio: "ignore"` e `unref()`, e reconecta com backoff até ~5s.
- Reconecta sozinho com backoff se o broker cair; se sumir de vez, sobe outro.
- **Removidos:** `killStaleProcess()` e o `process.exit(1)` em EADDRINUSE. Perder a corrida pela porta passa a ser normal e silencioso — era esse `exit(1)` que deixava a sessão com o MCP morto e sem volta.
- Divergência de `protocol` (broker antigo de uma versão npm anterior ainda de pé): erro claro dizendo como derrubá-lo, em vez de falha obscura.

**Plugin**
- O relógio de reconexão migra para o sandbox (`code.ts`), que cutuca a UI periodicamente para checar o estado do socket, contornando o throttling de timer no iframe oculto.
- Reconexão imediata no `onclose`, além do heartbeat.
- No reconectar, reenvia o `hello` — o broker trata como um alvo novo (novo `connId`).

## Erros

Pendências passam a ser rejeitadas **por alvo**, não em massa. Hoje a queda de um plugin rejeita `pendingRequests` inteiro (`mcp-server.ts:70-74`); com dois decks isso derrubaria comandos em voo do deck saudável.

O timeout de comando permanece em 15s (`COMMAND_TIMEOUT_MS`), agora medido por requisição e por alvo.

## Testes

O repositório não tem testes. Não será introduzido framework — o `node --test` embutido cobre o necessário sem dependência nova. O alvo é a lógica arriscada, não cobertura ampla:

- **Roteamento** — dois plugins e dois controladores conectados; a resposta chega apenas a quem pediu.
- **Resolução de alvo** — os quatro ramos, incluindo o erro de ambiguidade e o auto-select com um deck só.
- **Corrida de bind** — dois brokers subindo juntos; um vence, o outro sai com 0 em silêncio.
- **Reaper de zumbi** — cliente que para de responder pong é removido de `targets`.
- **Rejeição por alvo** — queda de um plugin não afeta pendências de outro.

## Migração

Sem migração de dados ou configuração. Requer `npm run build:mcp` para gerar `dist/broker.mjs` e o plugin atualizado precisa ser recarregado no Figma (o `ui.html` e o `code.js` mudam). Um broker de versão anterior em execução é detectado pelo `protocol` e reportado com instrução de encerramento.
