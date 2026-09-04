/**
 * PokerCoach AI — Bot de Discord
 * ---------------------------------------------------------------------------
 * Coach de Texas Hold'em (MTT, Cash e Spin & Go) construído sobre a API da
 * Anthropic. Responde por Slash Command (/poker), por menção direta ao bot
 * e por mensagem direta (DM).
 *
 * Stack: Node.js + TypeScript (ts-node) | discord.js v14 | @anthropic-ai/sdk
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type SendableChannels,
} from 'discord.js';
import 'dotenv/config';

// ===========================================================================
// 1. VARIÁVEIS DE AMBIENTE
// ===========================================================================

/** Lê uma variável obrigatória e encerra o processo se ela estiver ausente. */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `[config] Variável de ambiente obrigatória ausente: ${name}\n` +
        '         Copie o arquivo .env.example para .env e preencha os valores.',
    );
    process.exit(1);
  }
  return value;
}

const DISCORD_TOKEN = requireEnv('DISCORD_TOKEN');
const DISCORD_CLIENT_ID = requireEnv('DISCORD_CLIENT_ID');
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY');

/** Opcional: registra o comando apenas neste servidor (propagação instantânea). */
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID?.trim() || undefined;

// --- Configuração do modelo -------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5';

/**
 * Teto de tokens da resposta. IMPORTANTE: este limite cobre o raciocínio
 * interno + o texto visível. Valores baixos (< 4000) truncam análises longas
 * no meio. O limite de 2000 caracteres do Discord é resolvido pelo chunking
 * em `splitMessage`, não por este parâmetro.
 */
const MAX_TOKENS = Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '', 10) || 8000;

/** Profundidade de raciocínio: low | medium | high | xhigh | max. */
const EFFORT = process.env.ANTHROPIC_EFFORT?.trim() || 'medium';

// --- Configuração do histórico ---------------------------------------------

const HISTORY_MAX_MESSAGES =
  Number.parseInt(process.env.HISTORY_MAX_MESSAGES ?? '', 10) || 8;
const HISTORY_TTL_MS =
  (Number.parseInt(process.env.HISTORY_TTL_MINUTES ?? '', 10) || 30) * 60_000;

// --- Constantes do Discord --------------------------------------------------

/** Limite real do Discord é 2000; margem de segurança para os marcadores de bloco. */
const DISCORD_MESSAGE_LIMIT = 1_900;

/** O indicador de digitação expira em ~10s; renovamos antes disso. */
const TYPING_REFRESH_MS = 8_000;

// ===========================================================================
// 2. SYSTEM PROMPT
// ===========================================================================

const SYSTEM_PROMPT = `Você é o **PokerCoach AI**, um coach de elite de Texas Hold'em especializado em Teoria dos Jogos (GTO), estratégia exploratória (Exploit) e matemática aplicada ao poker. Sua expertise cobre MTTs, Cash Games e Spin & Go.

## IDENTIDADE E LINGUAGEM

- Tom profissional, direto e técnico. Sem rodeios, sem elogios vazios, sem disclaimers genéricos.
- Você fala com um jogador que quer melhorar, não com um iniciante que precisa ser poupado. Aponte leaks com clareza.
- Mantenha TODO o jargão técnico em inglês, na forma original — nunca traduza:
  C-bet, Check-Raise, Fold to C-bet, Overbet, Floating, Squeeze, 3-Bet, 4-Bet, Blockers, Unblockers,
  MDF, SPR, Node Locking, Barrel, Double Barrel, Triple Barrel, Jam, Shove, Open-Raise, Limp,
  Range, Polarized, Merged, Capped, Value Bet, Bluff Catcher, Donk Bet, Probe Bet, Delayed C-bet,
  Thin Value, Equity Realization, Fold Equity, ICM, Bubble Factor, Pot Odds, Implied Odds,
  Reverse Implied Odds, Wet Board, Dry Board, Nut Advantage, Range Advantage, Check Back, Float,
  Isolation, Cold Call, Check-Back, Backdoor, Runner-Runner.
- O restante da explicação vai em português do Brasil.

## ESTRUTURA OBRIGATÓRIA PARA ANÁLISE DE MÃOS

Sempre que o usuário enviar uma mão, um spot ou uma situação concreta, responda EXATAMENTE nesta estrutura, com estes quatro títulos:

**1. Visão Geral do Spot**
Posição dos jogadores envolvidos, stack efetivo (em BB), SPR no flop, tamanho do pote e dinâmica relevante da mesa. Se o formato for MTT, cite o estágio e o impacto de ICM. Se algum dado essencial estiver faltando, assuma o cenário mais comum e declare a suposição em uma linha.

**2. Linha Teórica GTO**
O baseline do solver: qual é a ação de equilíbrio e por quê. Cite as frequências aproximadas do range (ex.: "C-bet 33% pot em ~70% da frequência") e explique a construção do range — quais combos de value, quais bluffs, quais Blockers importam neste node.

**3. Ajuste Exploratório / Exploit**
Como desviar do GTO com base nos dados de HUD ou nos leaks que o usuário indicou (VPIP/PFR, 3-Bet%, Fold to C-bet, WTSD, WWSF, Aggression Frequency). Explicite o Node Locking: "se o vilão folda mais que MDF neste node, então...". Se o usuário NÃO forneceu reads, diga isso e liste qual estatística mudaria a decisão.

**4. Veredito e Recomendação de Ação**
A ação ideal e o sizing exato, em uma frase. Depois, no máximo três linhas de justificativa. Sem hedge: comprometa-se com a linha.

Para perguntas conceituais (teoria, rotina de estudo, mental game, bankroll), NÃO force essa estrutura — responda de forma direta e organizada.

## REGRAS MATEMÁTICAS

Sempre que a decisão depender de matemática, mostre a fórmula explícita e os números substituídos, nunca apenas o resultado:

- **Pot Odds** = Valor a pagar / (Pote total após o call)
  Ex.: Call de 50 em pote de 150 -> 50 / 200 = 25% de equity necessária.
- **SPR** = Stack efetivo / Tamanho do pote no flop
  Ex.: 300 de stack / 100 de pote -> SPR 3.0 (commitment threshold com top pair forte).
- **MDF** = 1 - (Aposta / (Aposta + Pote))
  Ex.: Bet de 75 em pote de 100 -> MDF = 1 - (75/175) = 57%. Foldar mais que 43% torna qualquer two-card bluff lucrativo.
- **Breakeven de Bluff** = Aposta / (Aposta + Pote)
  Ex.: Bet de 60 em pote de 100 -> 60/160 = 37.5% de fold equity necessária.
- **Equity necessária vs. Jam** — calcule e compare com a equity real da mão contra o range estimado.

Números primeiro, prosa depois. Se um cálculo não se aplica ao spot, não o inclua.

## FORMATAÇÃO

- Você escreve dentro do Discord: use markdown (**negrito**, listas, \`code\`), nunca LaTeX, nunca \`$...$\`, nunca \\frac{}{}.
- Use \`/\` para divisão e \`^\` para expoente.
- Cartas em maiúsculas com naipe abreviado: AhKs, QdQc, 7s6s. Boards no formato \`Ah 7s 2d\`.
- Seja denso. Sem preâmbulo ("Ótima pergunta!"), sem encerramento genérico ("Espero ter ajudado!"). Comece pela análise.`;

// ===========================================================================
// 3. CLIENTE ANTHROPIC
// ===========================================================================

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  maxRetries: 2,
  timeout: 180_000, // 3 min: análises com raciocínio profundo levam tempo
});

type CoachMessage = { role: 'user' | 'assistant'; content: string };

// ===========================================================================
// 4. HISTÓRICO DE CONVERSA (em memória, por usuário)
// ===========================================================================

interface ConversationEntry {
  messages: CoachMessage[];
  lastUsedAt: number;
}

const conversations = new Map<string, ConversationEntry>();

function getHistory(userId: string): CoachMessage[] {
  if (HISTORY_MAX_MESSAGES <= 0) return [];

  const entry = conversations.get(userId);
  if (!entry) return [];

  if (Date.now() - entry.lastUsedAt > HISTORY_TTL_MS) {
    conversations.delete(userId);
    return [];
  }
  return entry.messages;
}

function rememberExchange(userId: string, question: string, answer: string): void {
  if (HISTORY_MAX_MESSAGES <= 0) return;

  const messages = getHistory(userId).slice();
  messages.push({ role: 'user', content: question });
  messages.push({ role: 'assistant', content: answer });

  // Mantém apenas as últimas N mensagens, sempre começando por um turno 'user'.
  while (messages.length > HISTORY_MAX_MESSAGES) messages.shift();
  while (messages.length > 0 && messages[0]?.role !== 'user') messages.shift();

  conversations.set(userId, { messages, lastUsedAt: Date.now() });
}

/** Limpeza periódica das conversas expiradas (evita crescimento indefinido). */
const historySweeper = setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of conversations) {
    if (now - entry.lastUsedAt > HISTORY_TTL_MS) conversations.delete(userId);
  }
}, 5 * 60_000);
historySweeper.unref();

// ===========================================================================
// 5. CHAMADA À API DA ANTHROPIC
// ===========================================================================

/** Erro com mensagem já pronta para ser exibida ao usuário no Discord. */
class CoachError extends Error {
  constructor(public readonly userMessage: string, cause?: unknown) {
    super(userMessage);
    this.name = 'CoachError';
    if (cause instanceof Error) this.cause = cause;
  }
}

async function askPokerCoach(userId: string, question: string): Promise<string> {
  const messages: CoachMessage[] = [
    ...getHistory(userId),
    { role: 'user', content: question },
  ];

  try {
    // O cast abaixo mantém o código compilando em qualquer versão do SDK:
    // `thinking.adaptive` e `output_config.effort` são parâmetros recentes e as
    // tipagens do pacote publicado podem estar atrás da API.
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // O system prompt é estável entre requisições -> vale o cache de prefixo.
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      messages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);

    if (response.stop_reason === 'refusal') {
      throw new CoachError(
        'Não consigo responder essa mensagem. Reformule o spot focando na decisão de poker.',
      );
    }

    const answer = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!answer) {
      throw new CoachError(
        'O modelo retornou uma resposta vazia. Tente reenviar a mão com mais detalhes.',
      );
    }

    const finalAnswer =
      response.stop_reason === 'max_tokens'
        ? `${answer}\n\n_(resposta truncada no limite de tokens — peça a continuação)_`
        : answer;

    rememberExchange(userId, question, finalAnswer);
    return finalAnswer;
  } catch (error) {
    if (error instanceof CoachError) throw error;

    // Erros tipados do SDK — do mais específico para o mais genérico.
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('[anthropic] ANTHROPIC_API_KEY inválida ou revogada.', error);
      throw new CoachError(
        'Erro de autenticação com a IA. Avise o administrador do bot: a chave da API precisa ser verificada.',
      );
    }
    if (error instanceof Anthropic.RateLimitError) {
      console.warn('[anthropic] Rate limit atingido.', error);
      throw new CoachError(
        'Estou recebendo muitas requisições agora. Aguarde alguns segundos e envie a mão novamente.',
      );
    }
    if (error instanceof Anthropic.NotFoundError) {
      console.error(`[anthropic] Modelo não encontrado: ${MODEL}`, error);
      throw new CoachError(
        'O modelo configurado não está disponível. Avise o administrador do bot.',
      );
    }
    if (error instanceof Anthropic.APIConnectionError) {
      console.error('[anthropic] Falha de conexão.', error);
      throw new CoachError(
        'Não consegui falar com a IA (falha de rede). Tente de novo em instantes.',
      );
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`[anthropic] Erro de API (status ${error.status}).`, error);
      throw new CoachError(
        'A IA retornou um erro ao processar sua análise. Tente novamente em instantes.',
      );
    }

    console.error('[anthropic] Erro inesperado.', error);
    throw new CoachError(
      'Ocorreu um erro inesperado ao processar sua análise. Tente novamente.',
    );
  }
}

// ===========================================================================
// 6. LIMITE DE 2000 CARACTERES DO DISCORD
// ===========================================================================

/**
 * Fecha blocos de código que ficaram abertos ao cortar o texto e os reabre no
 * pedaço seguinte, para que a formatação não vaze entre as mensagens.
 */
function balanceCodeFences(chunks: string[]): string[] {
  const result: string[] = [];
  let openFence = false;

  for (let chunk of chunks) {
    if (openFence) chunk = `\`\`\`\n${chunk}`;

    const fenceCount = (chunk.match(/```/g) ?? []).length;
    openFence = fenceCount % 2 === 1;

    if (openFence) chunk = `${chunk}\n\`\`\``;
    result.push(chunk);
  }
  return result;
}

/**
 * Divide a resposta em pedaços que cabem no limite do Discord, preferindo
 * quebras em parágrafo/linha e só cortando no meio de uma linha se ela sozinha
 * já exceder o limite.
 */
function splitMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let current = '';

  for (const line of trimmed.split('\n')) {
    // A linha cabe no pedaço atual.
    if (current.length + line.length + 1 <= limit) {
      current = current ? `${current}\n${line}` : line;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    // Linha isolada maior que o limite: corte duro.
    let rest = line;
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current = rest;
  }

  if (current) chunks.push(current);
  return balanceCodeFences(chunks);
}

// ===========================================================================
// 7. INDICADOR DE DIGITAÇÃO
// ===========================================================================

/**
 * Dispara `sendTyping()` e o mantém ativo até a chamada da função de parada.
 * Retorna sempre uma função — nunca lança, mesmo sem permissão no canal.
 */
function startTyping(channel: SendableChannels): () => void {
  const ping = () => {
    void channel.sendTyping().catch(() => {
      /* sem permissão ou canal indisponível: o indicador é opcional */
    });
  };

  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  return () => clearInterval(timer);
}

// ===========================================================================
// 8. CLIENTE DISCORD
// ===========================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent, // intent privilegiada — habilite no portal
  ],
  // Necessário para receber DMs de canais que não estão em cache.
  partials: [Partials.Channel, Partials.Message],
});

/** Usuários com uma análise em andamento (evita filas duplicadas). */
const pendingUsers = new Set<string>();

// ===========================================================================
// 9. REGISTRO DO SLASH COMMAND
// ===========================================================================

const pokerCommand = new SlashCommandBuilder()
  .setName('poker')
  .setDescription('Analise uma mão ou tire uma dúvida com o PokerCoach AI')
  .addStringOption((option) =>
    option
      .setName('pergunta')
      .setDescription(
        'Descreva a mão (posições, stacks, board, ações) ou faça sua pergunta',
      )
      .setRequired(true)
      .setMaxLength(4000),
  );

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const body = [pokerCommand.toJSON()];

  try {
    if (DISCORD_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
        { body },
      );
      console.log(`[discord] /poker registrado no servidor ${DISCORD_GUILD_ID}.`);
    } else {
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body });
      console.log(
        '[discord] /poker registrado globalmente (pode levar até 1h para propagar).',
      );
    }
  } catch (error) {
    // Falhar aqui não deve derrubar o bot: menção e DM continuam funcionando.
    console.error('[discord] Falha ao registrar o slash command.', error);
  }
}

// ===========================================================================
// 10. HANDLER — SLASH COMMAND
// ===========================================================================

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const question = interaction.options.getString('pergunta', true).trim();
  const userId = interaction.user.id;

  if (!question) {
    await interaction.reply({
      content: 'Descreva a mão ou a dúvida que você quer analisar.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (pendingUsers.has(userId)) {
    await interaction.reply({
      content:
        'Já estou analisando uma mão sua. Aguarde a resposta antes de enviar outra.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pendingUsers.add(userId);

  // Sinaliza processamento imediatamente (o Discord expira a interação em 3s).
  await interaction.deferReply();

  const stopTyping = interaction.channel?.isSendable()
    ? startTyping(interaction.channel)
    : () => undefined;

  try {
    const answer = await askPokerCoach(userId, question);
    const chunks = splitMessage(answer);

    await interaction.editReply({ content: chunks[0] ?? '_(resposta vazia)_' });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk });
    }
  } catch (error) {
    const message =
      error instanceof CoachError
        ? `:warning: ${error.userMessage}`
        : ':warning: Ocorreu um erro inesperado. Tente novamente em instantes.';

    if (!(error instanceof CoachError)) {
      console.error('[handler:slash] Erro não tratado.', error);
    }

    await interaction.editReply({ content: message }).catch(() => undefined);
  } finally {
    stopTyping();
    pendingUsers.delete(userId);
  }
}

// ===========================================================================
// 11. HANDLER — MENÇÃO DIRETA E DM
// ===========================================================================

async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!client.user) return;

  const isDirectMessage = message.channel.isDMBased();
  const isMention = message.mentions.users.has(client.user.id);

  // Fora de DM, só respondemos quando o bot é mencionado explicitamente.
  if (!isDirectMessage && !isMention) return;
  // @everyone / @here não contam como chamada ao coach.
  if (message.mentions.everyone) return;

  // Remove a menção do texto para não poluir o prompt.
  const question = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!question) {
    await message.reply(
      'Manda a mão que eu analiso. Inclua **posições**, **stack efetivo (BB)**, **board** e a ' +
        '**sequência de ações** — e, se tiver, os números de HUD do vilão.\n' +
        'Você também pode usar `/poker`.',
    );
    return;
  }

  const userId = message.author.id;

  if (pendingUsers.has(userId)) {
    await message.reply('Já estou analisando uma mão sua. Aguarde a resposta.');
    return;
  }

  pendingUsers.add(userId);

  const stopTyping = message.channel.isSendable()
    ? startTyping(message.channel)
    : () => undefined;

  try {
    const answer = await askPokerCoach(userId, question);
    const chunks = splitMessage(answer);

    // O primeiro pedaço responde à mensagem; os demais seguem encadeados.
    let previous = await message.reply({ content: chunks[0] ?? '_(resposta vazia)_' });
    for (const chunk of chunks.slice(1)) {
      previous = await previous.reply({ content: chunk });
    }
  } catch (error) {
    const text =
      error instanceof CoachError
        ? `:warning: ${error.userMessage}`
        : ':warning: Ocorreu um erro inesperado. Tente novamente em instantes.';

    if (!(error instanceof CoachError)) {
      console.error('[handler:message] Erro não tratado.', error);
    }

    await message.reply(text).catch(() => undefined);
  } finally {
    stopTyping();
    pendingUsers.delete(userId);
  }
}

// ===========================================================================
// 12. EVENTOS
// ===========================================================================

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[discord] Online como ${readyClient.user.tag}`);
  console.log(
    `[anthropic] Modelo: ${MODEL} | max_tokens: ${MAX_TOKENS} | effort: ${EFFORT}`,
  );
  readyClient.user.setActivity('analisando spots | /poker');
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'poker') return;

  void handleSlashCommand(interaction).catch((error) => {
    console.error('[discord] Falha no handler de slash command.', error);
  });
});

client.on(Events.MessageCreate, (message) => {
  void handleMessage(message).catch((error) => {
    console.error('[discord] Falha no handler de mensagem.', error);
  });
});

client.on(Events.Error, (error) => {
  console.error('[discord] Erro do cliente.', error);
});

client.on(Events.Warn, (info) => {
  console.warn('[discord] Aviso:', info);
});

// ===========================================================================
// 13. ENCERRAMENTO LIMPO (SIGINT / SIGTERM)
// ===========================================================================

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[shutdown] Sinal ${signal} recebido. Encerrando...`);

  clearInterval(historySweeper);
  conversations.clear();
  pendingUsers.clear();

  try {
    await client.destroy();
    console.log('[shutdown] Conexão com o Discord encerrada.');
  } catch (error) {
    console.error('[shutdown] Erro ao encerrar a conexão.', error);
  }

  process.exit(0);
}

process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));

process.on('unhandledRejection', (reason) => {
  console.error('[process] Promise rejeitada sem tratamento:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[process] Exceção não capturada:', error);
  void shutdown('SIGTERM');
});

// ===========================================================================
// 14. BOOTSTRAP
// ===========================================================================

async function main(): Promise<void> {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
}

main().catch((error) => {
  console.error('[bootstrap] Falha ao iniciar o bot.', error);
  process.exit(1);
});
