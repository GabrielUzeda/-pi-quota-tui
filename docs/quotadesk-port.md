# Rastreabilidade do porte do QuotaDesk

Referência lida em:
`/home/gsuzeda/Downloads/QuotaDesk-template/src/QuotaDesk`.

O original é Windows/.NET 10/Windows Forms. Este projeto é uma implementação
Python para terminal Linux, sem depender do template em runtime e sem modificar
seus arquivos. Não copiamos binários, logos nem configurações pessoais.

## Mapeamento

| Referência | Notutil | Regra preservada |
|---|---|---|
| `Models.cs / LimitWindow.PacePercent` | `rules.pace` | (1 - tempo restante / duração) ×100; só 5h e semanal |
| `PaceDelta` | `rules.delta` | uso - ritmo; pontos percentuais, não % da capacidade restante |
| `PaceForecast` | `rules.forecast` | extrapolação linear com ~; sem projeção no começo da janela |
| `ProviderSnapshot.WithRenewals` | `Snapshot.outdated`, `rules.reset_text` | não zerar uso ao passar o reset |
| `Theme.PaceLabel/PaceColor` | `rules.pace_label/health` | até ±3% no ritmo; >3 atenção; >10 crítico |
| `AntigravityAgent.ParseQuotaSummary` | `providers.antigravity.parse_groups/parse_summary` | remainingFraction vira uso; grupos e janelas separados |
| `AntigravityAgent.ParseQuota` | `parse_legacy` | fallback por modelo, sem duração inventada |
| `AntigravityAgent.DiscoverAsync/ReadAsync` | `discover/collect_direct` | processo local, porta dos logs, CSRF só em memória |
| `CodexClient/CodexAgent` | `providers.openai` | `codex app-server --stdio`, initialize + account/rateLimits/read, 5h e semanal |
| `ClaudeQuota.ReadStatusLine` | `providers.claude.read_statusline` | statusLine exato, descarta reset vencido, vencido após 30 min |
| `ClaudeQuota.ReadDesktopHistory` | `read_history/estimate_reset` | amostras fh/sd da conta atual; reset 5h pelo início, semanal nunca inferido |
| `ClaudeQuota.MergeSources` | `providers.claude.collect` | statusLine recente prevalece e doa renovação exata ao histórico |
| `MonitorForm/Theme` | `ui.py` | um card de uma linha por ferramenta, selo de saúde, janela que bloqueia primeiro, barra com marca de ritmo, RENOVA EM, ACIMA/FOLGA/NO RITMO, paleta ciano/roxo/magenta/ambar/vermelho |
| `Theme.PaceColor/UsageColor` | `ui._usage_color`, tons do pace | uso esfria em ciano e esquenta até vermelho; ritmo verde/ambar/vermelho |
| clique na janela do card | seleção automática | a janela principal é a de menor folga; as outras vão para o rodapé |

**Atenção:** um comentário antigo de `WithRenewals` fala em zerar a janela.
O corpo atual do método e o guia dizem o contrário. Seguimos a implementação:
manter o último percentual real e aguardar a próxima leitura.

## Adaptações conscientes

- O template só tem Codex, Claude e Antigravity. **OpenCode não está no template.**
  Seu coletor usa o contrato do endpoint Go já utilizado pela integração local
  de quotas: `usage.{rolling,weekly,monthly}.{percent,resetsAt}`.
- O adaptador AGY é adicional. Usa o mesmo contrato de grupos do Antigravity e
  respeita a idade reportada pelo proxy. O template mostra uma conta; aqui o proxy
  devolve várias, então uma (a paga) vira o card e as demais viram bônus agregado.
  O bônus usa a melhor folga, nunca soma percentuais de contas diferentes.
  Identificadores são derivados por hash, sem guardar emails nos snapshots.
- O original prioriza estado de atividade (trabalhando/esperando/ocioso).
  Aqui não coletamos atividade: as quatro emoções representam a **saúde da quota**,
  explicitamente identificada na tela.
- O bloqueio de uso >=90% segue o destaque crítico do template. O mapeamento
  desse destaque para a emoção do nosso pet é regra nova do Notutil.
- O template persiste um cache seguro; esta versão só preserva leitura em memória.
- O monitor não interpreta uma queda de uso como renovação para emitir aviso.
  `RenewalWatcher` ainda não foi portado; assim não há aviso falso por troca de conta/grupo.
- Portamos as estimativas do histórico Claude apenas para a janela de 5h, com a
  mesma exigência de fronteira a até 2h. Não portamos o arquivo de renovação semanal
  confirmada pelo usuário, hooks, notificações, instalação Windows, clima ou bandeja.
- O cabeçalho de boas-vindas, as dicas e a agenda `.ics` são novos: o template
  tem título fixo e não integra calendário. O clima opcional também é novo
  (`wttr.in`), desligado por padrão.
- CommandCode vem do TUI local do Pi (`extensions/quota.ts`), não do template:
  janelas 5h/semanal quando publicadas, mensal reconstruída como saldo + consumido.
  O saldo em créditos é mostrado como nota, não convertido em percentual inventado.
- A leitura do Codex abre um subprocesso do CLI, então o intervalo de polling é 60s.

## Segurança e distribuição

Não lemos OAuth nem tokens: o Codex usa a sessão do próprio CLI e o Claude lê
apenas arquivos de uso. OpenCode e CommandCode usam a variável de ambiente e, na
falta dela, a chave `key` do `~/.pi/agent/auth.json` local (somente leitura, nunca
exibida ou registrada); o Antigravity direto usa apenas seu CSRF de sessão local.
O proxy local deve ser de confiança. Por não exigir credencial adicional em
loopback, outro processo local com acesso ao mesmo endpoint também pode ler suas
quotas; essa é uma característica do proxy, não uma barreira criada pelo Notutil.

Não foi encontrado arquivo de licença no pacote de referência. Este documento
registra a origem das regras e textos, mas **não concede licença sobre o template**.
Antes de redistribuir partes derivadas, confirme os direitos com seu autor.
