# StudioPilot — Agente de IA para Roblox Studio

**StudioPilot** transforma o **Claude** (claude.ai), o **ChatGPT** (chatgpt.com) e a **Arena** (arena.ai, incluindo o modo **Agent** em `/agent`) em um agente do Roblox Studio. Ler/editar scripts, executar Luau, inspecionar a árvore do jogo, inserir assets — tudo pelo chat, **sem API key, sem terminal, sem pagar nada**.

Inspirado no conceito do [ZeroScript-Free](https://github.com/sebattfg/ZeroScript-Free), com implementação própria (código original, licença MIT) e uma diferença importante de arquitetura: em vez do servidor MCP do Studio, o StudioPilot usa um **plugin próprio** + **bridge local em Python**, o que torna o sistema fácil de entender, testar e estender.

```
Chat de IA (Claude / ChatGPT / Arena, no navegador)
      │  extensão StudioPilot (content script)
      ▼  WebSocket  ws://127.0.0.1:17654/ws
Bridge local (bridge.py)
      ▲  HTTP long-poll  http://127.0.0.1:17655/api/*
      │  plugin StudioPilot (HttpService — Roblox não tem WebSocket)
Roblox Studio
```

## Como funciona

1. Você clica em **▶ Iniciar sessão** na barra do StudioPilot (injeta o "system prompt" + seu pedido no chat).
2. A IA responde com um bloco ` ```json ` contendo comandos (`{"commands":[...]}`).
3. A extensão extrai esses comandos e manda para a bridge; a bridge entrega ao plugin; o plugin executa no Studio e devolve os resultados.
4. A extensão envia os resultados de volta para a IA — e o loop continua sozinho até a IA terminar com `TASK_COMPLETE`.

## Instalação

### 1. Extensão (Chrome / Edge / Brave / Arc)

1. Vá em `chrome://extensions` (ou `edge://extensions`).
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** (*Load unpacked*).
4. Selecione a pasta `studiopilot-extension`.

### 2. Plugin do Roblox Studio

1. Abra o Roblox Studio e um place qualquer.
2. Menu **PLUGINS → Plugins Folder** (abre a pasta de plugins).
3. Copie `studio-plugin/StudioPilot.lua` para dentro dessa pasta e reinicie o Studio.
4. Aparece um botão **StudioPilot: ON** na toolbar + painel lateral de status.

> Se o painel mostrar erro de HTTP: **Game Settings → Security → Enable Studio Access to API Services** e reative o botão. O plugin só fala com `127.0.0.1` (sua própria máquina).

### 3. Bridge (o "meio de campo")

- **Windows:** dê dois cliques em `start.bat`.
- **macOS:** dê dois cliques em `MacOS_Start.command` (na primeira vez o macOS avisa sobre segurança — *System Settings → Privacy & Security → Open Anyway*).
- **Linux:** `bash MacOS_Start.command` (ou `python3 bridge.py`).

Precisa de Python 3.9+; o launcher instala o pacote `websockets` sozinho na primeira execução. Deixe a janela aberta enquanto usa.

### 4. Usar

Abra uma nova conversa em **claude.ai**, **chatgpt.com** ou **arena.ai/agent**. A barra preta do StudioPilot aparece no canto inferior direito. Descreva a tarefa (ex.: *"crie um sistema de checkpoint com leaderstats e uma loja"*), clique em **▶ Iniciar sessão** e acompanhe o Studio trabalhar.

## Bolinha de status

| Cor | Significado |
|-----|-------------|
| 🟢 Verde | Bridge + Studio conectados (place aberto) |
| 🟡 Amarela | Bridge OK, mas o Studio não conectou (abra o Studio/place e verifique o plugin) |
| ⚪ Cinza | Bridge offline — rode `start.bat` / `MacOS_Start.command` |

## O que a IA pode fazer (ações disponíveis)

| Ação | Descrição |
|------|-----------|
| `ping` | testa a conexão |
| `get_scripts` | lista todos os scripts (caminho + classe) |
| `read_script` `{path}` | lê o Source completo |
| `set_script` `{path, source, className?}` | cria ou sobrescreve um script (pastas criadas automaticamente) |
| `delete_script` `{path}` | remove um script |
| `run_code` `{code}` | executa Luau agora, no edit mode, com permissões de plugin |
| `get_tree` `{path?, maxDepth?}` | árvore de instâncias do jogo |
| `set_property` `{path, property, value}` | altera propriedades (suporta Vector3, Color3, UDim2, Enum, CFrame…) |
| `insert_asset` `{assetId, parentPath?}` | insere asset do catálogo por ID |
| `get_console_output` `{afterId?}` | lê a janela de Output |
| `get_selection` | seleção atual no Studio |

Caminhos aceitos: `game.Workspace.Part`, `Workspace/Part`, `game["Meu Part"].Filho`.

## Segurança e privacidade

- **100% local**: a bridge só escuta em `127.0.0.1`; nenhum dado sai da sua máquina além do que a própria IA do chat vê.
- Sem API keys, sem contas extras, sem telemetria.
- O `run_code` executa código arbitrário no Studio (é o que dá o poder de agente). Revise sessões críticas — a IA recebe instrução explícita de nunca fazer deleções amplas.
- Portas configuráveis em `config.json` (`extension_port`, `studio_port`).

## Testes

O projeto tem testes automatizados do que dá para testar fora do navegador/Studio:

```bash
# 1) Parser de comandos da extensão (30 casos) — precisa só de Node
node tests/test_parser.mjs

# 2) Bridge end-to-end: bridge real + plugin falso (HTTP) + extensão falsa (WebSocket)
pip install websockets
python tests/test_e2e.py
```

O e2e sobe a **bridge de verdade** e valida: handshake, flip de status online/offline, execução de lote com 8 comandos (incl. criar script e ler de volta, erro de Luau, ação desconhecida), validação de parâmetros, timeout de job e falha rápida com Studio offline.

> Os testes de UI dos chats (Claude/ChatGPT/Arena) são manuais: os sites mudam o DOM com o tempo. Os providers foram escritos com seletores em camadas (vários fallbacks) — se algum site atualizar e a barra não achar o campo de texto, o log da barra mostra o motivo.

## Estrutura

```
config.json                  portas e timeouts da bridge
bridge.py                    bridge local (WebSocket ⇄ HTTP long-poll)
start.bat                    launcher Windows
MacOS_Start.command          launcher macOS/Linux
studio-plugin/
  StudioPilot.lua            plugin do Roblox Studio (instalar na Plugins Folder)
studiopilot-extension/
  manifest.json              MV3, content scripts por site
  core/config.js             constantes + system prompt da IA
  core/parser.js             extrator tolerante de comandos (fences + brace-match)
  core/dom.js                helpers de composer (textarea/ProseMirror/TipTap)
  core/main.js               loop do agente + barra de controle (Shadow DOM)
  providers/claude.js        driver do claude.ai
  providers/chatgpt.js       driver do chatgpt.com
  providers/arena.js         driver do arena.ai (chat Direct e modo /agent)
  popup.html / popup.js      status rápido no ícone da extensão
  background.js              service worker (status p/ popup)
tests/
  test_parser.mjs            30 testes do parser (Node)
  test_e2e.py                teste ponta a ponta da bridge (Python)
```

## Problemas comuns

- **Bolinha cinza**: a bridge não está rodando → rode o launcher da sua plataforma.
- **Bolinha amarela**: bridge OK mas Studio ausente → plugin instalado? place aberto? botão "StudioPilot: ON"?
- **"studio_offline" na barra**: mesmo caso acima; o botão **Retomar** reexecuta os comandos depois que você conectar.
- **A IA responde texto em vez de agir**: lembre-a: *"use o formato de comandos json"* ou comece nova sessão.
- **Porta ocupada**: a bridge tenta recuperar portas de uma instância anterior automaticamente; se for outro programa, troque em `config.json`.

## Licença

MIT — veja [LICENSE](LICENSE). Código original; o nome/conceito "agente via extensão + bridge" é inspirado no ZeroScript-Free (GPLv3), mas nenhum código foi copiado.
