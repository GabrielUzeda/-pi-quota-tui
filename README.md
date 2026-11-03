# pi-quota-tui — cotas de IA no pi

Painel com as cotas das suas assinaturas de IA, em texto puro ANSI, dentro do [pi](https://pi.dev).
Funciona em qualquer terminal: sem imagens, sem animação, sem depender de fonte ou protocolo gráfico.
Não envia prompts e não chama modelos: só lê o estado de uso de cada conta.

![Painel de cotas logo abaixo do editor do pi](https://raw.githubusercontent.com/GabrielUzeda/pi-quota-tui/main/assets/preview.svg)

Provedores: **OpenCode Go**, **Antigravity** (direto no Google, sem proxy local), **Claude Code** e **CommandCode**. O **OpenAI Codex** também, mas exige o CLI `codex` (veja abaixo).

## Instalação

```sh
pi install npm:pi-quota-tui
```

Ou direto do repositório:

```sh
pi install git:github.com/GabrielUzeda/pi-quota-tui
```

Para remover: `pi remove npm:pi-quota-tui`.

O painel aparece sozinho ao abrir o pi, como uma lista abaixo do editor.
Os dados são atualizados a cada 2 minutos.

## Formato

Nome do provedor e as janelas de cota separadas por `│`, com barra de saldo e tempo até renovar.
Dois provedores partilham a linha quando há espaço.

```text
Antigravity Gemini ████████ 6d │ Gemini ████████ 6h        OpenCode Go ███░░░░░░ 3.2h
            Claude ░░░░░░░░ 2d │ Argon ░░░░░░░░ 2d         OpenAI Codex ████████ 2.8h
CommandCode ██░░░░░░ 45m
```

- A barra mostra o **saldo restante**; o `│` dentro dela é a marca de ritmo (onde o saldo deveria estar para durar até a renovação).
- A cor da barra é o ritmo, não o saldo: verde com folga, amarelo de 3 a 10 pontos adiantado, vermelho acima disso. Sem reset/duração conhecidos, ela usa o saldo (azul, amarelo a partir de 75% usado, vermelho a partir de 90%).
- Quando as janelas não cabem, a linha quebra com recuo alinhado sob a primeira janela.
- Janela esgotada (100% usado) esconde ela e as abaixo dela na hierarquia mensal > semanal > 5h, no mesmo grupo. Mensal zerado tira o provedor do painel; semanal zerado deixa só o mensal. Janelas sem hierarquia (as "Limite" do Antigravity) nunca somem.
- O que esgotou volta numa linha final `Expired:`, com o tempo até renovar: por grupo vale a janela que trava as de baixo, ordenado de quem volta antes para quem volta depois, com a tag em vermelho forte e o tempo numa rampa contínua verde → amarelo → vermelho conforme a espera pesa no ciclo da janela (18h numa semanal é verde; 12d numa mensal não). Provedor só com cotas esgotadas continua na tela por essa linha.
- O painel não escreve avisos: nem `DESATUALIZADO`, nem `ATENCAO`. Quem quiser o diagnóstico usa `/quota`.
- As cores dos nomes seguem a marca: Antigravity azul, OpenAI verde, Claude laranja; OpenCode e CommandCode usam a cor padrão do texto, que acompanha tema claro e escuro. Sem truecolor, as cores caem para 256 cores automaticamente.

## Comandos e ferramenta

| Comando | O que faz |
|---|---|
| `/quotas` | Mostra ou esconde o painel |
| `/quota [all\|opencode\|agy\|commandcode]` | Relatório de texto no chat (não entra no contexto do modelo) |
| `/usage` | Alias de `/quota` |
| `/quota-login` | Importa as contas Antigravity do AGY ou faz o login Google na própria extensão |

A ferramenta `get_quotas` entrega o mesmo relatório ao modelo, quando você pedir.

## Configuração

Cada provedor só aparece se estiver configurado **e** com pelo menos uma janela de cota. Provedor sem configuração, ou sem nenhuma leitura, fica fora do painel; `/quota` mostra o motivo.

| Provedor | Como configurar |
|---|---|
| OpenCode Go | Entrada `opencode-go` em `~/.pi/agent/auth.json`; sem ela, variável `OPENCODE_GO_KEY` |
| CommandCode | Entrada `commandcode` em `auth.json`; sem ela, `COMMAND_CODE_API_KEY` (ou `COMMANDCODE_API_KEY`) |
| Antigravity | Lista de contas em `~/.local/share/pi-quota-tui/agy-accounts.json` (`[{ email, projectId, refreshToken }]`, modo `600`), criada por `/quota-login`. O `accounts.json` do AGY é lido só como fallback e `PI_QUOTA_TUI_AGY_ACCOUNTS` sobrepõe os dois. Sem proxy rodando. |
| OpenAI Codex | **Obrigatório para puxar as quotas dele:** CLI `codex` instalado e no PATH (as quotas são lidas com `codex app-server`). Sem o CLI, o provedor simplesmente não aparece. |
| Claude Code | Histórico do app desktop (`plan-usage-history.json`) e, sem ele, OAuth da assinatura (`/login` Claude Pro/Max no pi). A primeira fonte com dados vence; sem nenhuma, o provedor fica fora do painel |

O `auth.json` só é lido se estiver com permissão `600` (sem acesso de grupo ou outros). **Ele tem prioridade**; as variáveis de ambiente são o fallback quando a seção não existe, está vazia ou o arquivo é rejeitado.

Variável opcional: `PI_QUOTA_TUI_AGY_PAID`, pista para escolher a conta paga do Antigravity.

## O que cada provedor precisa para funcionar

Nada abaixo é instalado pela extensão: ela só lê o que já existe na máquina e consulta a rede. Faltando o pré-requisito, o provedor sai do painel e `/quota` mostra o motivo.

| Provedor | Credencial | Arquivo ou binário externo | Rede |
|---|---|---|---|
| OpenCode Go | seção `opencode-go` do `auth.json`, ou `OPENCODE_GO_KEY` | — | `GET opencode.ai/zen/go/v1/usage` |
| CommandCode | seção `commandcode` do `auth.json`, ou `COMMAND_CODE_API_KEY`/`COMMANDCODE_API_KEY` | — | `GET api.commandcode.ai/alpha/billing/credits` e `/usage/summary` |
| Antigravity | `refreshToken` de cada conta Google (client OAuth do CLI Antigravity, embutido no código) | nenhum: `/quota-login` mantém o arquivo com modo `600` (ver abaixo) | OAuth do Google + `v1internal:retrieveUserQuotaSummary` |
| OpenAI Codex | login do próprio `codex` (a extensão **não** usa `auth.json` para ele) | **binário `codex` no PATH**, que aceite `codex app-server --stdio` | nenhuma chamada HTTP: fala JSON-RPC com o subprocesso |
| Claude Code | histórico do app desktop, ou token `anthropic` tipo `oauth` no `auth.json` (`/login` Claude Pro/Max) | `plan-usage-history.json` (opcional) | `GET api.anthropic.com/api/oauth/usage` (só no fallback OAuth) |

### `/quota-login`: de onde vêm as contas do Antigravity

`/quota-login` mantém `~/.local/share/pi-quota-tui/agy-accounts.json` (modo `600`) e resolve as contas em três passos:

1. **Arquivo próprio válido** — renova o token de cada conta; se todas passarem, não faz mais nada.
2. **Importar do AGY uma vez** — lê `~/.local/share/agy-local-proxy/accounts.json` (o arquivo do **AGY Local Proxy**, um proxy Node de terceiros em `~/.local/share/agy-local-proxy/server.mjs` que serve o Antigravity como endpoint OpenAI em `127.0.0.1:20128`; o proxy só lê esse arquivo, não tem rota de gravar nem de login, então ele nasceu de edição manual). As contas cujo `refreshToken` o Google ainda renova são copiadas para o arquivo próprio.
3. **Login na própria extensão** — sem nenhum token válido para importar, abre um OAuth loopback (`127.0.0.1:<porta>` + PKCE) com o client do CLI Antigravity, mostra a URL no painel e grava o `refreshToken` recebido. A conta entra sem `projectId`, então a coleta usa o projeto padrão do Cloud Code; para fixar outro, edite o JSON e adicione `projectId`.

Depois disso a extensão é **autônoma**: o arquivo é dela, o AGY pode ser desinstalado, e `PI_QUOTA_TUI_AGY_ACCOUNTS` continua servindo para apontar para outro caminho. O acoplamento que sobra é a credencial: o `refreshToken` precisa ter sido emitido para o client OAuth do CLI Antigravity (o `client_id`/`client_secret` embutidos no código); token de outro client é recusado na renovação.

## Como os dados são lidos

- Consultas têm timeout de 25 s. Respostas são limitadas a 2 MiB e redirecionamentos não são seguidos.
- HTTP só é aceito em `127.0.0.1`. Erros aparecem como mensagens curtas, sem URL, cabeçalho ou corpo da resposta.
- Se uma consulta falhar, o painel mantém a última leitura; o motivo aparece em /quota.
- Antigravity renova o token no Google e consulta `v1internal:retrieveUserQuotaSummary` direto, sem processo local. As contas vêm de um arquivo (ver Configuração); as famílias aparecem separadas (Gemini, Claude/GPT, Gemini 4 Argon) e contas diferentes não são somadas nem promediadas. O access token fica só em memória.

## Limitações

- **Antigravity (credencial embutida):** o refresh do token usa o client OAuth do CLI Antigravity, publicado no código por decisão do autor. Se o Google revogar ou limitar esse client, o provedor para de funcionar e volta a exigir um client próprio (`PI_QUOTA_TUI_AGY_CLIENT_ID`/`_SECRET` seria o caminho). Cooldowns por modelo não são lidos: só existiam no proxy.
- Testado em Linux.
- **Claude Code (débito):** o histórico do desktop e o fallback OAuth já estão ligados, mas o caminho OAuth (`GET https://api.anthropic.com/api/oauth/usage`, header `anthropic-beta: oauth-2025-04-20`, token `anthropic` `type: "oauth"` do `auth.json`) **não tem teste de integração** — exige um login Claude Pro/Max real. Só `parseOauthUsage` é testado; cobrir rede/401 quando houver credencial de teste.

## Desenvolvimento

```sh
npm install
npm test          # testes e smoke test da extensão
npm run typecheck
```

## Pacote do pi

Este repositório é publicado no npm como [`pi-quota-tui`](https://www.npmjs.com/package/pi-quota-tui) com a keyword `pi-package`, o que o deixa elegível ao [catálogo de pacotes do pi](https://pi.dev/packages). O campo `pi.extensions` aponta para `./src/index.ts` e `pi.image` para a prévia acima.

## Licença

MIT. Veja `LICENSE`.
