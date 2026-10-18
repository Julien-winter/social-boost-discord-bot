require('dotenv').config();
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder,
  Events, GatewayIntentBits, ModalBuilder, REST, Routes, SlashCommandBuilder,
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
  return new EmbedBuilder().setColor(0x5865f2).setTitle('Service Panel')
    .setDescription('Use the buttons or slash commands to browse services, place orders and check status.')
    .setFooter({ text: 'Administration and limits are configured on the server.' });
}
function panelRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_services').setLabel('Services').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_order').setLabel('Place order').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_status').setLabel('Status').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_balance').setLabel('Balance').setStyle(ButtonStyle.Secondary)
  )];
}
function adminRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_pause').setLabel('Pause queue').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('admin_resume').setLabel('Resume queue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('admin_queue').setLabel('Show queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_clear').setLabel('Clear failed').setStyle(ButtonStyle.Danger)
  )];
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
  const lines = services.slice(0, 25).map((service) => `**${service.service} · ${safe(service.name)}**\n${safe(service.category)} · ${service.min}-${service.max} · Rate ${service.rate}`);
  await interaction.reply({ content: lines.join('\n\n') || 'No services found.', ephemeral: true });
}
async function createOrder(interaction, order) {
  if (!allowed(interaction)) return interaction.reply({ content: 'Rate limit reached. Please try again shortly.', ephemeral: true });
  const item = queue.enqueue({ userId: interaction.user.id, order });
  await interaction.reply({ content: `Added to the queue. Ticket: \`${item.id.slice(0, 8)}\``, ephemeral: true });
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
      if (interaction.commandName === 'balance') { const result = await api.balance(); return interaction.reply({ content: `Balance: **${safe(result.balance)} ${safe(result.currency)}**`, ephemeral: true }); }
      if (interaction.commandName === 'status') { const result = await api.orderStatus(interaction.options.getString('order')); return interaction.reply({ content: `\`Status\` ${safe(result.status)} · Remaining: ${safe(result.remains)} · Charge: ${safe(result.charge)}`, ephemeral: true }); }
      if (interaction.commandName === 'order') return createOrder(interaction, { service: interaction.options.getInteger('service'), link: interaction.options.getString('link'), quantity: interaction.options.getInteger('quantity'), runs: interaction.options.getInteger('runs'), interval: interaction.options.getInteger('interval') });
      if (interaction.commandName === 'admin') {
        if (!isAdmin(interaction)) return interaction.reply({ content: 'You do not have permission to use this.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'panel') return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Admin Panel').setColor(0xed4245).setDescription('Manage the queue and bot operating state.')], components: adminRows(), ephemeral: true });
        if (sub === 'queue') return interaction.reply({ content: queueText(), ephemeral: true });
        if (sub === 'pause') { queue.pause(); return interaction.reply({ content: 'Queue paused.', ephemeral: true }); }
        if (sub === 'resume') { queue.resume(); return interaction.reply({ content: 'Queue resumed.', ephemeral: true }); }
        if (sub === 'clear') { queue.clear(); return interaction.reply({ content: 'Failed items removed.', ephemeral: true }); }
      }
    }
    if (interaction.isButton()) {
      if (interaction.customId === 'panel_services') return showServices(interaction);
      if (interaction.customId === 'panel_order') return interaction.showModal(orderModal());
      if (interaction.customId === 'panel_status') return interaction.showModal(statusModal());
      if (interaction.customId === 'panel_balance') { const result = await api.balance(); return interaction.reply({ content: `Balance: **${safe(result.balance)} ${safe(result.currency)}**`, ephemeral: true }); }
      if (!isAdmin(interaction)) return interaction.reply({ content: 'You do not have permission to use this.', ephemeral: true });
      if (interaction.customId === 'admin_pause') { queue.pause(); return interaction.update({ content: 'Queue paused.', embeds: [], components: adminRows() }); }
      if (interaction.customId === 'admin_resume') { queue.resume(); return interaction.update({ content: 'Queue resumed.', embeds: [], components: adminRows() }); }
      if (interaction.customId === 'admin_queue') return interaction.reply({ content: queueText(), ephemeral: true });
      if (interaction.customId === 'admin_clear') { queue.clear(); return interaction.update({ content: 'Failed items removed.', embeds: [], components: adminRows() }); }
    }
    if (interaction.isModalSubmit() && interaction.customId === 'order_modal') {
      const number = (id) => Number(interaction.fields.getTextInputValue(id));
      const quantity = number('quantity');
      if (!Number.isInteger(number('service')) || !Number.isInteger(quantity) || quantity < 1) return interaction.reply({ content: 'Service ID and quantity must be valid numbers.', ephemeral: true });
      return createOrder(interaction, { service: number('service'), link: interaction.fields.getTextInputValue('link'), quantity, runs: number('runs') || undefined, interval: number('interval') || undefined });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'status_modal') { const result = await api.orderStatus(interaction.fields.getTextInputValue('order')); return interaction.reply({ content: `\`Status\` ${safe(result.status)} · Remaining: ${safe(result.remains)} · Charge: ${safe(result.charge)}`, ephemeral: true }); }
  } catch (error) {
    console.error(error);
    const content = errorText(error);
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true });
    else await interaction.reply({ content, ephemeral: true });
  }
});

client.login(config.token);
