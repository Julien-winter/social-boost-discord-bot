require('dotenv').config();
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder,
  Events, GatewayIntentBits, MessageFlags, ModalBuilder, REST, Routes, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const http = require('node:http');
const { BoostApiClient, BoostApiError } = require('./apiClient');
const { OrderQueue } = require('./queue');
const { CreditStore } = require('./credits');
const { NowPaymentsProvider, CryptoProviderError } = require('./cryptoProvider');
const {
  customerRate,
  formatMoney,
  formatQuantity,
  formatUnit,
  normalizePricingConfig,
  orderCost
} = require('./pricing');
const { platformFromService, serviceMatches, servicePlatforms } = require('./serviceCatalog');

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  adminUsers: new Set((process.env.ADMIN_USER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)),
  adminRoles: new Set((process.env.ADMIN_ROLE_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)),
  rateWindowMs: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60) * 1000,
  rateMax: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 8)
  ,creditCurrency: process.env.CREDIT_CURRENCY || 'USD'
  ,creditDivisor: Number(process.env.CREDIT_RATE_DIVISOR || 1000)
  ,profitPercent: Number(process.env.PROFIT_PERCENT || 0)
  ,dataDir: process.env.DATA_DIR || 'data'
  ,cryptoPort: Number(process.env.CRYPTO_WEBHOOK_PORT || 0)
  ,cryptoCallbackUrl: process.env.CRYPTO_CALLBACK_URL || ''
};
normalizePricingConfig({ divisor: config.creditDivisor, profitPercent: config.profitPercent });
if (!config.token || !config.clientId) throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set.');

const api = new BoostApiClient({ apiKey: process.env.BOOST_API_KEY, apiUrl: process.env.BOOST_API_URL });
const credits = new CreditStore(require('node:path').join(config.dataDir, 'credits.json'), { currency: config.creditCurrency });
const queue = new OrderQueue(api, { concurrency: process.env.QUEUE_CONCURRENCY, onFailed: (item) => credits.refund(item.userId, item.reservationId, { ticket: item.id }) });
const cryptoProvider = process.env.CRYPTO_API_KEY && process.env.CRYPTO_IPN_SECRET
  ? new NowPaymentsProvider({ apiKey: process.env.CRYPTO_API_KEY, ipnSecret: process.env.CRYPTO_IPN_SECRET, sandbox: process.env.CRYPTO_SANDBOX === 'true', currency: process.env.CRYPTO_PRICE_CURRENCY || 'usd' })
  : null;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rateBuckets = new Map();
const serviceViews = new Map();

function isAdmin(interaction) {
  if (config.adminUsers.has(interaction.user.id)) return true;
  return interaction.member?.roles?.cache?.some((role) => config.adminRoles.has(role.id)) || false;
}
function allowed(interaction) {
  const now = Date.now();
  const bucket = rateBuckets.get(interaction.user.id) || [];
  const fresh = bucket.filter((timestamp) => now - timestamp < config.rateWindowMs);
  if (fresh.length >= config.rateMax) return false;
  fresh.push(now); rateBuckets.set(interaction.user.id, fresh); return true;
}
function safe(value) { return String(value ?? '').slice(0, 1000); }
function limitText(value, max = 1900) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n…and more items.`;
}
function servicePriceText(service) {
  const providerRate = Number(service.rate);
  const sellRate = customerRate(providerRate, config.profitPercent);
  return `Provider: **${formatMoney(providerRate, config.creditCurrency)} / ${formatUnit(config.creditDivisor)}**\nYour price: **${formatMoney(sellRate, config.creditCurrency)} / ${formatUnit(config.creditDivisor)}**`;
}
function errorText(error) {
  if (error?.code === 'INSUFFICIENT_CREDITS') return error.message;
  if (error instanceof CryptoProviderError) return `Crypto provider error: ${safe(error.message)}`;
  if (error instanceof BoostApiError) return `API error: ${safe(error.message)}`;
  return `Error: ${safe(error.message || error)}`;
}
function isUnknownInteraction(error) {
  return error?.code === 10062 || error?.rawError?.code === 10062;
}
function panelEmbed() {
  return new EmbedBuilder()
    .setColor(0x7c5cff)
    .setAuthor({ name: 'Social Boost Center', iconURL: client.user?.displayAvatarURL() })
    .setTitle('🚀 Start here')
    .setDescription('Everything you need is one click away.\n\n**1 · Browse** services\n**2 · Add credits** securely\n**3 · Create** an order\n**4 · Track** your order')
    .addFields(
      { name: '📦 Services', value: 'See available services, limits and rates.', inline: true },
      { name: '🛒 Orders', value: 'Create an order through the protected queue. Credits are reserved first.', inline: true },
      { name: '🛡️ Protected', value: `Rate limit: ${config.rateMax} requests / ${Math.round(config.rateWindowMs / 1000)}s`, inline: true }
    )
    .setFooter({ text: 'Need help? Use /services, /order, /status or /balance.' });
}
function panelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_services').setLabel('Browse services').setEmoji('📦').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_order').setLabel('Create order').setEmoji('🛒').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel_credits').setLabel('My credits').setEmoji('💳').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_status').setLabel('Track order').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
      // Use a standard Unicode emoji. The Bitcoin sign (₿) is a text symbol,
      // not a Discord-valid emoji name, so Discord rejects the whole panel.
      new ButtonBuilder().setCustomId('panel_deposit').setLabel('Add credits').setEmoji('💰').setStyle(ButtonStyle.Success)
    )
  ];
}
function adminRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_pause').setLabel('Pause queue').setEmoji('⏸️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('admin_resume').setLabel('Resume queue').setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('admin_queue').setLabel('View queue').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_clear').setLabel('Clear failed').setEmoji('🧹').setStyle(ButtonStyle.Danger)
    )
  ];
}

const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open the service panel'),
  new SlashCommandBuilder().setName('services').setDescription('List available services'),
  new SlashCommandBuilder().setName('credits').setDescription('Show your private credit balance'),
  new SlashCommandBuilder().setName('deposit').setDescription('Create a crypto deposit').addNumberOption((o) => o.setName('amount').setDescription('Amount in USD').setRequired(true).setMinValue(1).setMaxValue(10000)),
  new SlashCommandBuilder().setName('balance').setDescription('Show the current balance'),
  new SlashCommandBuilder().setName('status').setDescription('Show an order status').addStringOption((o) => o.setName('order').setDescription('Order ID').setRequired(true)),
  new SlashCommandBuilder().setName('order').setDescription('Add an order to the queue')
    .addIntegerOption((o) => o.setName('service').setDescription('Service ID').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('link').setDescription('Target link').setRequired(true))
    .addIntegerOption((o) => o.setName('quantity').setDescription('Required quantity').setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName('runs').setDescription('Optional runs').setMinValue(1))
    .addIntegerOption((o) => o.setName('interval').setDescription('Optional interval in minutes').setMinValue(1)),
  new SlashCommandBuilder().setName('admin').setDescription('Open admin controls')
    .addSubcommand((s) => s.setName('panel').setDescription('Open admin controls'))
    .addSubcommand((s) => s.setName('queue').setDescription('Show the queue'))
    .addSubcommand((s) => s.setName('pause').setDescription('Pause new orders'))
    .addSubcommand((s) => s.setName('resume').setDescription('Resume the queue'))
    .addSubcommand((s) => s.setName('clear').setDescription('Remove failed queue items'))
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
  try {
    await rest.put(route, { body: commands });
    console.log(config.guildId ? `Registered commands in guild ${config.guildId}.` : 'Registered global commands.');
  } catch (error) {
    if (error?.code === 50001 || error?.status === 403) {
      console.error('Could not register slash commands: Discord returned Missing Access. Check that DISCORD_CLIENT_ID belongs to this bot and that the bot was invited to DISCORD_GUILD_ID with the applications.commands scope.');
    } else {
      console.error('Could not register slash commands:', error);
    }
  }
}
function queueText() {
  const items = queue.snapshot().slice(-15);
  if (!items.length) return 'The queue is empty.';
  return limitText(items.map((item) => `\`${item.id.slice(0, 8)}\` · **${item.status}** · User <@${item.userId}>${item.result?.order ? ` · Order ${item.result.order}` : ''}${item.error ? ` · ${safe(item.error)}` : ''}`).join('\n'));
}
function orderModal() {
  return new ModalBuilder().setCustomId('order_modal').setTitle('New order').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('service').setLabel('Service ID').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('link').setLabel('Target link').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('Quantity').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('runs').setLabel('Runs (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('interval').setLabel('Interval in minutes (optional)').setStyle(TextInputStyle.Short).setRequired(false))
  );
}
function statusModal() {
  return new ModalBuilder().setCustomId('status_modal').setTitle('Order status').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('order').setLabel('Order ID').setStyle(TextInputStyle.Short).setRequired(true)));
}
function depositModal() {
  return new ModalBuilder().setCustomId('deposit_modal').setTitle('Add credits with crypto').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Amount in USD').setPlaceholder('Example: 10').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12))
  );
}
function servicePageRows(page, pageCount, categories, categoryIndex, hasQuery, platforms, platform) {
  const categoryOptions = [{ label: 'All categories', value: 'category:all', description: 'Show every available service', default: categoryIndex === null }]
    .concat(categories.slice(0, 24).map((category, index) => ({
      label: safe(category).slice(0, 100), value: `category:${index}`, description: 'Filter services in this category', default: categoryIndex === index
    })));
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('services_platform').setPlaceholder('Choose a platform').addOptions(
        [{ label: 'All platforms', value: 'platform:all', description: 'Show TikTok, YouTube, Twitch and more', default: platform === null }]
          .concat(platforms.slice(0, 24).map((item) => ({ label: item, value: `platform:${item}`, description: `Show ${item} services`, default: platform === item })))
      ).setMaxValues(1).setMinValues(1)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('services_category').setPlaceholder('Filter by category').addOptions(categoryOptions).setMaxValues(1).setMinValues(1)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`services_page_prev_${page}`).setLabel('Previous').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`services_page_info_${page}`).setLabel(`Page ${page + 1} / ${pageCount}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`services_page_next_${page}`).setLabel('Next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('services_search').setLabel(hasQuery ? 'Change search' : 'Search services').setEmoji('🔎').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('services_reset').setLabel('Reset filters').setEmoji('↩️').setStyle(ButtonStyle.Secondary).setDisabled(categoryIndex === null && platform === null && !hasQuery)
    )
  ];
}
async function showServices(interaction, requestedPage = 0) {
  if (!allowed(interaction)) {
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Rate limit reached. Please try again shortly.', flags: MessageFlags.Ephemeral });
    return;
  }
  const isPrivateReply = interaction.isChatInputCommand()
    || (interaction.isButton() && interaction.customId === 'panel_services')
    || (interaction.isModalSubmit() && interaction.customId === 'services_search_modal');
  // A component interaction must be acknowledged within Discord's short
  // response window. Keep this guard idempotent because a fast double-click
  // can dispatch the same panel action while the first request is running.
  if (!interaction.replied && !interaction.deferred) {
    if (isPrivateReply) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferUpdate();
  }

  const services = await api.services();
  if (!services.length) return interaction.editReply({ content: 'No services found.', embeds: [], components: [] });
  const categories = [...new Set(services.map((service) => String(service.category || 'Other')).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const view = serviceViews.get(interaction.user.id) || { categoryIndex: null, platform: null, query: '' };
  const selectedCategory = view.categoryIndex === null ? null : categories[view.categoryIndex];
  const selectedPlatform = view.platform || null;
  const query = view.query.trim().toLowerCase();
  const platforms = servicePlatforms(services);
  const filtered = services.filter((service) => serviceMatches(service, { platform: selectedPlatform, category: selectedCategory, query }));
  const pageSize = 6;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(Number(requestedPage) || 0, 0), pageCount - 1);
  const fields = filtered.slice(page * pageSize, (page + 1) * pageSize).map((service) => ({
    name: `#${service.service} · ${safe(service.name).slice(0, 80)}`,
    value: [
      `Platform: **${platformFromService(service)}** · Type: **${safe(service.type || 'Default')}**`,
      `Quantity: **${formatQuantity(service.min)}–${formatQuantity(service.max)} units**`,
      servicePriceText(service),
      `Features: ${service.refill ? '🔁 Refill' : 'No refill'} · ${service.cancel ? '✖️ Cancel' : 'No cancel'}`
    ].join('\n'),
    inline: false
  }));
  const filterLabel = [selectedPlatform || 'All platforms', selectedCategory || 'All categories', query ? `Search: “${safe(view.query).slice(0, 40)}”` : ''].filter(Boolean).join(' · ');
  const description = filtered.length
    ? `**${filterLabel}**\nShowing services **${page * pageSize + 1}–${Math.min((page + 1) * pageSize, filtered.length)}** of **${filtered.length}**.\n\n**How to read prices:** quantity is the number of boosts; prices are shown per ${formatUnit(config.creditDivisor)}. The customer price includes the configured ${config.profitPercent}% profit margin. Use **/order** with the service ID.`
    : `**${filterLabel}**\nNo matching services. Try another platform, category or search term.`;
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📦 Service browser').setDescription(description).addFields(fields).setFooter({ text: `${services.length} total services · Profit margin: ${config.profitPercent}% · 🔁 refill · ✖️ cancel` });
  const payload = { embeds: [embed], components: servicePageRows(page, pageCount, categories, view.categoryIndex, Boolean(query), platforms, selectedPlatform) };
  // The initial browser is private. Later filters and pagination edit that
  // private response after acknowledging the interaction immediately.
  await interaction.editReply(payload);
}
function servicesSearchModal() {
  return new ModalBuilder().setCustomId('services_search_modal').setTitle('Search services').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('Search by platform, type or keyword').setPlaceholder('Example: TikTok followers').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80))
  );
}
async function createOrder(interaction, order) {
  if (!allowed(interaction)) return interaction.reply({ content: 'Rate limit reached. Please try again shortly.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const services = await api.services();
  const service = services.find((item) => Number(item.service) === Number(order.service));
  if (!service) return interaction.editReply({ content: 'That service ID is not available anymore.' });
  const quantity = Number(order.quantity);
  const runs = Number(order.runs || 1);
  if (quantity < Number(service.min) || quantity > Number(service.max)) return interaction.editReply({ content: `Quantity must be between ${service.min} and ${service.max}.` });
  const amount = orderCost(service.rate, quantity, runs, { divisor: config.creditDivisor, profitPercent: config.profitPercent });
  const reservation = await credits.reserve(interaction.user.id, amount, { service: order.service, quantity, runs });
  const item = queue.enqueue({ userId: interaction.user.id, order, reservationId: reservation.id, creditAmount: reservation.amount });
  await interaction.editReply({ content: `Added to the queue. Ticket: \`${item.id.slice(0, 8)}\`\nQuantity: **${formatQuantity(quantity * runs)} boosts** · Customer price: **${formatMoney(reservation.amount, config.creditCurrency)}** (includes ${config.profitPercent}% profit)\nRemaining credits: **${formatMoney(reservation.balance, config.creditCurrency)}**` });
}
async function showBalance(interaction) {
  if (!allowed(interaction)) return interaction.reply({ content: 'Rate limit reached. Please try again shortly.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await api.balance();
  return interaction.editReply({ content: `Balance: **${safe(result.balance)} ${safe(result.currency)}**` });
}
async function showStatus(interaction, order) {
  if (!allowed(interaction)) return interaction.reply({ content: 'Rate limit reached. Please try again shortly.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await api.orderStatus(order);
  return interaction.editReply({ content: `\`Status\` ${safe(result.status)} · Remaining: ${safe(result.remains)} · Charge: ${safe(result.charge)}` });
}
async function showCredits(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const balance = credits.getBalance(interaction.user.id);
  return interaction.editReply({ content: `Your credit balance: **${balance.toFixed(2)} ${config.creditCurrency}**\nUse **/deposit amount:<amount>** to add credits with crypto.` });
}
async function createDeposit(interaction, amount) {
  if (!allowed(interaction)) return interaction.reply({ content: 'Rate limit reached. Please try again shortly.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!cryptoProvider) return interaction.editReply({ content: 'Crypto deposits are not configured yet. Set CRYPTO_API_KEY, CRYPTO_IPN_SECRET and CRYPTO_CALLBACK_URL on the bot server.' });
  if (!config.cryptoCallbackUrl) return interaction.editReply({ content: 'Crypto deposits are unavailable because CRYPTO_CALLBACK_URL is missing.' });
  if (!config.cryptoCallbackUrl.startsWith('https://')) return interaction.editReply({ content: 'Crypto deposits require an HTTPS CRYPTO_CALLBACK_URL so payment notifications can be verified securely.' });
  const deposit = await credits.createDeposit(interaction.user.id, amount, { payCurrency: process.env.CRYPTO_PAY_CURRENCY || 'usdttrc20' });
  const payment = await cryptoProvider.createPayment({ amount: deposit.amount, payCurrency: deposit.payCurrency, orderId: deposit.id, callbackUrl: config.cryptoCallbackUrl });
  const providerPaymentId = payment.payment_id || payment.id;
  if (!providerPaymentId || !payment.pay_address || !payment.pay_amount || !payment.pay_currency) throw new Error('Crypto provider returned an incomplete payment response. No credits were added.');
  const linked = await credits.attachProviderPayment(deposit.id, providerPaymentId, { payAddress: payment.pay_address, payAmount: payment.pay_amount, payCurrency: payment.pay_currency, paymentUrl: payment.invoice_url || payment.payment_url });
  return interaction.editReply({ content: `Deposit **${deposit.amount.toFixed(2)} ${config.creditCurrency}** created.\nPayment ID: \`${safe(linked.providerPaymentId)}\`\nSend **${safe(linked.payAmount)} ${safe(linked.payCurrency)}** to:\n\`${safe(linked.payAddress)}\`\nCredits are added automatically after the provider confirms the payment.` });
}
function startCryptoWebhook() {
  if (!cryptoProvider || !config.cryptoPort) return;
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/crypto/webhook') { response.writeHead(404); return response.end('Not found'); }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      try {
        if (!cryptoProvider.verifyIpnSignature(rawBody, request.headers['x-nowpayments-sig'])) { response.writeHead(401); return response.end('Invalid signature'); }
        const payload = JSON.parse(rawBody.toString('utf8'));
        const result = await credits.completeDeposit({
          depositId: payload.order_id,
          providerPaymentId: payload.payment_id,
          status: payload.payment_status,
          actualAmount: payload.price_amount,
          actualPayAmount: payload.actually_paid ?? payload.pay_amount
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        console.error('Crypto webhook error:', error);
        response.writeHead(400); response.end('Invalid webhook');
      }
    });
  });
  server.listen(config.cryptoPort, () => console.log(`Crypto webhook listening on port ${config.cryptoPort}.`));
}

client.once(Events.ClientReady, async (readyClient) => {
  await registerCommands();
  console.log(`Logged in as ${readyClient.user.tag}`);
});
client.on(Events.Error, (error) => console.error('Discord client error:', error));
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') return interaction.reply({ embeds: [panelEmbed()], components: panelRows(), flags: MessageFlags.Ephemeral });
      if (interaction.commandName === 'services') return showServices(interaction);
      if (interaction.commandName === 'credits') return showCredits(interaction);
      if (interaction.commandName === 'deposit') return createDeposit(interaction, interaction.options.getNumber('amount'));
      if (interaction.commandName === 'balance') return showCredits(interaction);
      if (interaction.commandName === 'status') return showStatus(interaction, interaction.options.getString('order'));
      if (interaction.commandName === 'order') return createOrder(interaction, { service: interaction.options.getInteger('service'), link: interaction.options.getString('link'), quantity: interaction.options.getInteger('quantity'), runs: interaction.options.getInteger('runs'), interval: interaction.options.getInteger('interval') });
      if (interaction.commandName === 'admin') {
        if (!isAdmin(interaction)) return interaction.reply({ content: 'You do not have permission to use this.', flags: MessageFlags.Ephemeral });
        const sub = interaction.options.getSubcommand();
        if (sub === 'panel') return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🛠️ Admin control center').setDescription('Manage queue flow and failed items. These controls are restricted to configured admins.').addFields({ name: 'Queue status', value: queue.paused ? '⏸️ Paused' : '▶️ Running', inline: true }, { name: 'Items', value: String(queue.snapshot().length), inline: true })], components: adminRows(), flags: MessageFlags.Ephemeral });
        if (sub === 'queue') return interaction.reply({ content: queueText(), flags: MessageFlags.Ephemeral });
        if (sub === 'pause') { queue.pause(); return interaction.reply({ content: 'Queue paused.', flags: MessageFlags.Ephemeral }); }
        if (sub === 'resume') { queue.resume(); return interaction.reply({ content: 'Queue resumed.', flags: MessageFlags.Ephemeral }); }
        if (sub === 'clear') { queue.clear(); return interaction.reply({ content: 'Failed items removed.', flags: MessageFlags.Ephemeral }); }
      }
    }
    if (interaction.isButton()) {
      if (interaction.customId === 'panel_services') return showServices(interaction);
      if (interaction.customId === 'services_search') return interaction.showModal(servicesSearchModal());
      if (interaction.customId === 'services_reset') { serviceViews.set(interaction.user.id, { categoryIndex: null, platform: null, query: '' }); return showServices(interaction); }
      if (interaction.customId.startsWith('services_page_prev_')) return showServices(interaction, Number(interaction.customId.split('_').pop()) - 1);
      if (interaction.customId.startsWith('services_page_next_')) return showServices(interaction, Number(interaction.customId.split('_').pop()) + 1);
      if (interaction.customId === 'panel_order') return interaction.showModal(orderModal());
      if (interaction.customId === 'panel_status') return interaction.showModal(statusModal());
      if (interaction.customId === 'panel_credits') return showCredits(interaction);
      if (interaction.customId === 'panel_deposit') return interaction.showModal(depositModal());
      if (interaction.customId === 'panel_balance') return showCredits(interaction);
      if (!isAdmin(interaction)) return interaction.reply({ content: 'You do not have permission to use this.', flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'admin_pause') { queue.pause(); return interaction.update({ content: 'Queue paused.', embeds: [], components: adminRows() }); }
      if (interaction.customId === 'admin_resume') { queue.resume(); return interaction.update({ content: 'Queue resumed.', embeds: [], components: adminRows() }); }
      if (interaction.customId === 'admin_queue') return interaction.reply({ content: queueText(), flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'admin_clear') { queue.clear(); return interaction.update({ content: 'Failed items removed.', embeds: [], components: adminRows() }); }
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'services_category') {
      const value = interaction.values[0] || 'category:all';
      serviceViews.set(interaction.user.id, { ...(serviceViews.get(interaction.user.id) || {}), categoryIndex: value === 'category:all' ? null : Number(value.split(':')[1]), platform: serviceViews.get(interaction.user.id)?.platform || null, query: serviceViews.get(interaction.user.id)?.query || '' });
      return showServices(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'services_platform') {
      const value = interaction.values[0] || 'platform:all';
      serviceViews.set(interaction.user.id, { ...(serviceViews.get(interaction.user.id) || {}), categoryIndex: null, platform: value === 'platform:all' ? null : value.slice('platform:'.length), query: serviceViews.get(interaction.user.id)?.query || '' });
      return showServices(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'order_modal') {
      const number = (id) => Number(interaction.fields.getTextInputValue(id));
      const quantity = number('quantity');
      if (!Number.isInteger(number('service')) || !Number.isInteger(quantity) || quantity < 1) return interaction.reply({ content: 'Service ID and quantity must be valid numbers.', flags: MessageFlags.Ephemeral });
      return createOrder(interaction, { service: number('service'), link: interaction.fields.getTextInputValue('link'), quantity, runs: number('runs') || undefined, interval: number('interval') || undefined });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'status_modal') return showStatus(interaction, interaction.fields.getTextInputValue('order'));
    if (interaction.isModalSubmit() && interaction.customId === 'deposit_modal') {
      const amount = Number(interaction.fields.getTextInputValue('amount'));
      if (!Number.isFinite(amount) || amount < 1 || amount > 10000) return interaction.reply({ content: 'Enter a valid amount between 1 and 10,000 USD.', flags: MessageFlags.Ephemeral });
      return createDeposit(interaction, amount);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'services_search_modal') {
      serviceViews.set(interaction.user.id, { ...(serviceViews.get(interaction.user.id) || { categoryIndex: null, platform: null }), query: interaction.fields.getTextInputValue('query') || '' });
      return showServices(interaction);
    }
  } catch (error) {
    // A stale button can outlive its interaction token (Discord error 10062).
    // There is no response left to send in that case, so avoid a noisy second
    // API call and let the user use the current panel message instead.
    if (isUnknownInteraction(error)) return;
    console.error(error);
    const content = errorText(error);
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      if (!isUnknownInteraction(replyError)) console.error('Could not send interaction error response:', replyError);
    }
  }
});

client.login(config.token);
startCryptoWebhook();
