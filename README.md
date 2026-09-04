# PokerCoach AI — Bot de Discord

Coach de Texas Hold'em (MTT, Cash Game e Spin & Go) para Discord, construído em
Node.js + TypeScript sobre a API da Anthropic. Analisa mãos com baseline **GTO**,
ajuste **Exploit** e matemática explícita (Pot Odds, SPR, MDF).

## Recursos

- **Slash Command `/poker`** — envie a mão ou a dúvida direto pelo campo do comando.
- **Menção `@PokerCoach`** — funciona em qualquer canal onde o bot tenha acesso.
- **Mensagem Direta (DM)** — conversa privada, sem precisar mencionar.
- **Indicador de digitação** (`sendTyping`) renovado enquanto a IA processa.
- **Divisão automática** de respostas acima do limite de 2000 caracteres do Discord,
  quebrando por parágrafo e preservando blocos de código.
- **Memória curta de conversa** por usuário (últimas 8 mensagens, TTL de 30 min),
  para follow-ups como "e se ele tivesse 3-betado?".
- **Prompt caching** do system prompt — reduz custo e latência a cada requisição.
- **Tratamento de erro amigável** por tipo (rate limit, autenticação, rede, refusal).
- **Encerramento limpo** em `SIGINT` / `SIGTERM`.

## Estrutura da resposta de análise

1. **Visão Geral do Spot** — posição, stack efetivo, SPR, pote e dinâmica.
2. **Linha Teórica GTO** — baseline do solver e frequências do range.
3. **Ajuste Exploratório / Exploit** — Node Locking com base em HUD e leaks.
4. **Veredito e Recomendação de Ação** — ação ideal e sizing exato.

Jargão técnico é mantido em inglês (C-bet, Check-Raise, Overbet, Squeeze, 3-Bet,
Blockers, MDF, SPR, Node Locking, Barrel, Jam…).

## Pré-requisitos

- Node.js 20.10 ou superior
- Uma aplicação de bot no [Discord Developer Portal](https://discord.com/developers/applications)
- Uma chave de API do [Console da Anthropic](https://console.anthropic.com/settings/keys)

## Instalação

```bash
npm install
cp .env.example .env    # no PowerShell: Copy-Item .env.example .env
```

Preencha o `.env` com `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` e `ANTHROPIC_API_KEY`.

## Configuração no Discord Developer Portal

1. **Bot → Privileged Gateway Intents:** ative **MESSAGE CONTENT INTENT**.
   Sem isso, o bot recebe menções e DMs com o conteúdo vazio.
2. **Installation → Guild Install → Scopes:** `bot` e `applications.commands`.
3. **Permissões mínimas:** `Send Messages`, `Read Message History`,
   `Use Slash Commands`, `Embed Links`.

URL de convite (substitua `SEU_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=SEU_CLIENT_ID&permissions=274877975552&scope=bot%20applications.commands
```

## Execução

```bash
npm run dev        # desenvolvimento (ts-node, sem type-check — inicia rápido)
npm start          # ts-node com type-check completo
npm run typecheck  # apenas valida os tipos
npm run build      # compila para dist/
npm run start:prod # roda o build compilado
```

Ao iniciar, o console mostra o registro do `/poker` e o modelo em uso.

## Uso

```
/poker pergunta: BTN 45BB abre 2.2x, BB defende. Flop Ah 7s 2d, pote 5BB.
Tenho KdQd. Vilão tem Fold to C-bet 68%. C-bet ou check back?

@PokerCoach como calculo MDF contra um overbet de 150% pot?
```

Em DM, basta escrever normalmente.

## Docker

A imagem é multi-stage: o TypeScript é compilado no build e a imagem final roda
apenas o `dist/` com dependências de produção, como usuário sem privilégios.

```bash
docker compose up -d --build   # sobe em background
docker compose logs -f         # acompanha os logs
docker compose down            # encerra (SIGTERM -> shutdown limpo)
```

O `.env` fica **apenas no host** e é lido via `env_file` — nunca entra na imagem
(o `.dockerignore` também o exclui). Se o `.env` não existir, o
`docker compose up` falha imediatamente com `env file ... not found`, o que é
proposital: melhor falhar no boot do que subir um container sem credenciais.

Sem compose:

```bash
docker build -t poker-coach-ai-discord .
docker run -d --name poker-coach-ai --env-file .env --init --restart unless-stopped poker-coach-ai-discord
```

O container não expõe portas — a comunicação com o Discord é um WebSocket de saída.

## Integração contínua

O workflow `.github/workflows/ci.yml` roda em todo push e pull request para `main`:

- **type-check strict** e **build** em Node 20 e 22;
- verificação de que `dist/bot.js` foi gerado;
- smoke test de boot: o processo precisa sair com código diferente de zero e
  emitir a mensagem de variável de ambiente ausente;
- build da imagem Docker (com cache do GitHub Actions) e verificação de que o
  container sobe e aplica a mesma validação de ambiente.

## Configuração do modelo

| Variável                | Padrão            | Descrição                                                     |
| ----------------------- | ----------------- | ------------------------------------------------------------- |
| `ANTHROPIC_MODEL`       | `claude-sonnet-5` | Também aceita `claude-opus-5` ou `claude-haiku-4-5`.          |
| `ANTHROPIC_MAX_TOKENS`  | `8000`            | Cobre **raciocínio + texto visível**. Abaixo de 4000 trunca.   |
| `ANTHROPIC_EFFORT`      | `medium`          | `low` \| `medium` \| `high` \| `xhigh` \| `max`.               |
| `HISTORY_MAX_MESSAGES`  | `8`               | Mensagens de contexto por usuário. `0` desativa a memória.     |
| `HISTORY_TTL_MINUTES`   | `30`              | Expiração do histórico por inatividade.                        |

> **Nota sobre parâmetros:** os modelos atuais da Anthropic rejeitam `temperature`,
> `top_p` e `top_k` (erro 400) — a consistência de tom vem do system prompt.
> O modelo `claude-3-5-sonnet-20241022` foi descontinuado e retorna 404.

## Notas de operação

- O histórico de conversa fica **em memória** — reiniciar o processo o descarta.
  Para persistência entre deploys, troque o `Map` por Redis ou um banco.
- Cada usuário só pode ter **uma análise em andamento** por vez (anti-spam).
- Não commite o `.env`: ele já está no `.gitignore`.

## Licença

MIT
