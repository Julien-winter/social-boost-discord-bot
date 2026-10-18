require('dotenv').config();
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder,
  Events, GatewayIntentBits, MessageFlags, ModalBuilder, REST, Routes, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const { BoostApiClient, BoostApiError } = require('./apiClient');
const { OrderQueue } = require('./queue');

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  adminUsers: new Set((process.env.ADMIN_USER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)),
  adminRoles: new Set((process.env.ADMIN_ROLE_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)),
  rateWindowMs: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60) * 1000,
  rateMax: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 8)
};
if (!config.token || !config.clientId) throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set.');

const api = new BoostApiClient({ apiKey: process.env.BOOST_API_KEY, apiUrl: process.env.BOOST_API_URL });
const queue = new OrderQueue(api, { concurrency: process.env.QUEUE_CONCURRENCY });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rateBuckets = new Map();

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
function errorText(error) {
  if (error instanceof BoostApiError) return `API error: ${safe(error.message)}`;
  return `Error: ${safe(error.message || error)}`;
}
function panelEmbed() {
  return new EmbedBuilder()
    .setColor(0x7c5cff)
    .setAuthor({ name: 'Social Boost Center', iconURL: client.user?.displayAvatarURL() })
    .setTitle('🚀 Start here')
    .setDescription('Everything you need is one click away.\n\n**1 · Browse** services\n**2 · Create** an order\n**3 · Track** your order\n**4 · Check** your balance')
    .addFields(
      { name: '📦 Services', value: 'See available services, limits and rates.', inline: true },
      { name: '🛒 Orders', value: 'Create an order through the protected queue.', inline: true },
      { name: '🛡️ Protected', value: `Rate limit: ${config.rateMax} requests / ${Math.round(config.rateWindowMs / 1000)}s`, inline: true }
    )
    .setFooter({ text: 'Need help? Use /services, /order, /status or /balance.' });
}
function panelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_services').setLabel('Browse services').setEmoji('📦').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_order').setLabel('Create order').setEmoji('🛒').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_status').setLabel('Track order').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_balance').setLabel('Check balance').setEmoji('💰').setStyle(ButtonStyle.Secondary)
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
  return items.map((item) => `\`${item.id.slice(0, 8)}\` · **${item.status}** · User <@${item.userId}>${item.result?.order ? ` · Order ${item.result.order}` : ''}${item.error ? ` · ${safe(item.error)}` : ''}`).join('\n');
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
async function showServices(interaction) {
  const services = await api.services();
  if (!services.length) return interaction.reply({ content: 'No services found.', flags: MessageFlags.Ephemeral });
  const fields = services.slice(0, 25).map((service) => ({
    name: `#${service.service} · ${safe(service.name).slice(0, 230)}`,
    value: `**Category:** ${safe(service.category)}\n**Range:** ${service.min}-${service.max}\n**Rate:** ${service.rate}${service.refill ? ' · 🔁 Refill' : ''}${service.cancel ? ' · ✖️ Cancel' : ''}`,
    inline: true
  }));
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📦 Available services').setDescription(`Showing ${fields.length} of ${services.length} services. Use /order with the service ID.`).addFields(fields).setFooter({ text: 'Rates and availability come from the API.' });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
async function createOrder(interaction, order) {
  if (!allowed(interaction)) return interaction.reply({ content: 'Rate limit reached. Please try again shortly.', flags: MessageFlags.Ephemeral });
  const item = queue.enqueue({ userId: interaction.user.id, order });
  await interaction.reply({ content: `Added to the queue. Ticket: \`${item.id.slice(0, 8)}\``, flags: MessageFlags.Ephemeral });
}

client.once(Events.ClientReady, async (readyClient) => {
  await registerCommands();
  console.log(`Logged in as ${readyClient.user.tag}`);
});
client.on(Events.Error, (error) => console.error('Discord client error:', error));
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') return interaction.reply({ embeds: [panelEmbed()], components: panelRows() });
      if (interaction.commandName === 'services') return showServices(interaction);
      if (interaction.commandName === 'balance') { const result = await api.balance(); return interaction.reply({ content: `Balance: **${safe(result.balance)} ${safe(result.currency)}**`, flags: MessageFlags.Ephemeral }); }
      if (interaction.commandName === 'status') { const result = await api.orderStatus(interaction.options.getString('order')); return interaction.reply({ content: `\`Status\` ${safe(result.status)} · Remaining: ${safe(result.remains)} · Charge: ${safe(result.charge)}`, flags: MessageFlags.Ephemeral }); }
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
      if (interaction.customId === 'panel_order') return interaction.showModal(orderModal());
      if (interaction.customId === 'panel_status') return interaction.showModal(statusModal());
      if (interaction.customId === 'panel_balance') { const result = await api.balance(); return interaction.reply({ content: `Balance: **${safe(result.balance)} ${safe(result.currency)}**`, flags: MessageFlags.Ephemeral }); }
      if (!isAdmin(interaction)) return interaction.reply({ content: 'You do not have permission to use this.', flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'admin_pause') { queue.pause(); return interaction.update({ content: 'Queue paused.', embeds: [], components: adminRows() }); }
      if (interaction.customId === 'admin_resume') { queue.resume(); return interaction.update({ content: 'Queue resumed.', embeds: [], components: adminRows() }); }
      if (interaction.customId === 'admin_queue') return interaction.reply({ content: queueText(), flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'admin_clear') { queue.clear(); return interaction.update({ content: 'Failed items removed.', embeds: [], components: adminRows() }); }
    }
    if (interaction.isModalSubmit() && interaction.customId === 'order_modal') {
      const number = (id) => Number(interaction.fields.getTextInputValue(id));
      const quantity = number('quantity');
      if (!Number.isInteger(number('service')) || !Number.isInteger(quantity) || quantity < 1) return interaction.reply({ content: 'Service ID and quantity must be valid numbers.', flags: MessageFlags.Ephemeral });
      return createOrder(interaction, { service: number('service'), link: interaction.fields.getTextInputValue('link'), quantity, runs: number('runs') || undefined, interval: number('interval') || undefined });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'status_modal') { const result = await api.orderStatus(interaction.fields.getTextInputValue('order')); return interaction.reply({ content: `\`Status\` ${safe(result.status)} · Remaining: ${safe(result.remains)} · Charge: ${safe(result.charge)}`, flags: MessageFlags.Ephemeral }); }
  } catch (error) {
    console.error(error);
    const content = errorText(error);
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
});

client.login(config.token);
