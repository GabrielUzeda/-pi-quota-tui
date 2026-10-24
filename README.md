# notutil-pi — cotas de IA e pets no pi

Painel lateral com as cotas das suas assinaturas de IA e cinco mascotes em pixel-art, dentro do [pi](https://pi.dev).
Não envia prompts e não chama modelos: só lê o estado de uso de cada conta.

Provedores: **OpenCode Go**, **Antigravity** (via proxy local), **Claude Code** e **CommandCode**. O **OpenAI Codex** também, mas exige o CLI `codex` (veja abaixo).

## Instalação

```sh
pi install npm:notutil-pi
```

Ou direto do repositório:

```sh
pi install git:github.com/gsuzeda/notutil
```

Para remover: `pi remove npm:notutil-pi`.

O painel aparece sozinho ao abrir o pi, no canto direito, quando o terminal tem pelo menos 110 colunas.
Os dados são atualizados a cada 2 minutos.

## Comandos e ferramenta

| Comando | O que faz |
|---|---|
| `/quotas` | Mostra ou esconde o painel lateral |
| `/quota [all\|opencode\|agy\|commandcode]` | Relatório de texto no chat (não entra no contexto do modelo) |
| `/usage` | Alias de `/quota` |

A ferramenta `get_quotas` entrega o mesmo relatório ao modelo, quando você pedir.

## Configuração

Cada provedor só aparece se estiver configurado. Provedor sem configuração fica fora do painel; `/quota` lista os que faltam configurar.

| Provedor | Como configurar |
|---|---|
| OpenCode Go | Variável `OPENCODE_GO_KEY` ou entrada `opencode-go` em `~/.pi/agent/auth.json` |
| CommandCode | Variável `COMMAND_CODE_API_KEY` (ou `COMMANDCODE_API_KEY`) ou entrada `commandcode` em `auth.json` |
| Antigravity | Proxy `agy-local-proxy` rodando em `127.0.0.1:20128` |
| OpenAI Codex | **Obrigatório para puxar as quotas dele:** CLI `codex` instalado e no PATH (as quotas são lidas com `codex app-server`). Sem o CLI, o provedor simplesmente não aparece. |
| Claude Code | Statusline do Claude Code ativa, ou histórico do app desktop |

O `auth.json` só é lido se estiver com permissão `600` (sem acesso de grupo ou outros).

Variáveis opcionais:

- `NOTUTIL_PET_FPS`: frames por segundo da animação dos mascotes. Padrão `2`. Use `0` para desligar a animação. A cota continua atualizando a cada 2 minutos.
- `NOTUTIL_AGY_PAID`: pista para escolher a conta paga do Antigravity.

## Como os dados são lidos

- Consultas têm timeout de 25 s. Respostas são limitadas a 2 MiB e redirecionamentos não são seguidos.
- HTTP só é aceito em `127.0.0.1`. Erros aparecem como mensagens curtas, sem URL, cabeçalho ou corpo da resposta.
- Se uma consulta falhar, a última leitura continua no painel, marcada como antiga, com o motivo da falha.

## Limitações

- Antigravity: só o caminho do proxy. A descoberta direta do servidor de linguagem (via `/proc`) da versão Python não foi portada.
- Imagens dos mascotes em caracteres (meio-bloco), sem o modo de imagem do terminal da versão Python.
- Testado em Linux.

## Desenvolvimento

```sh
npm install
npm test          # testes e smoke test da extensão
npm run typecheck
```

`src/pets-data.ts` é gerado a partir de `notutil/pets.py` (versão Python, mantida só como referência de desenho):

```sh
npm run export-pets   # requer python3
```

## Licença

MIT. Veja `LICENSE`.
