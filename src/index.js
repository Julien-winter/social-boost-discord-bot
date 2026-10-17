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
if (!config.token || !config.clientId) throw new Error('DISCORD_TOKEN und DISCORD_CLIENT_ID müssen gesetzt sein.');

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
  if (error instanceof BoostApiError) return `API-Fehler: ${safe(error.message)}`;
  return `Fehler: ${safe(error.message || error)}`;
}
function panelEmbed() {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('Service Panel')
    .setDescription('Nutze die Buttons oder Slash-Commands für Services, Bestellungen und Statusabfragen.')
    .setFooter({ text: 'Verwaltung und Limits sind serverseitig konfiguriert.' });
}
function panelRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_services').setLabel('Services').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_order').setLabel('Bestellung').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_status').setLabel('Status').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_balance').setLabel('Guthaben').setStyle(ButtonStyle.Secondary)
  )];
}
function adminRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_pause').setLabel('Queue pausieren').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('admin_resume').setLabel('Queue fortsetzen').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('admin_queue').setLabel('Queue anzeigen').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_clear').setLabel('Fehlgeschlagene entfernen').setStyle(ButtonStyle.Danger)
  )];
}

const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Öffnet das Service Panel'),
  new SlashCommandBuilder().setName('services').setDescription('Zeigt verfügbare Services'),
  new SlashCommandBuilder().setName('balance').setDescription('Zeigt das aktuelle Guthaben'),
  new SlashCommandBuilder().setName('status').setDescription('Zeigt den Bestellstatus').addStringOption((o) => o.setName('order').setDescription('Order-ID').setRequired(true)),
  new SlashCommandBuilder().setName('order').setDescription('Stellt eine Bestellung in die Queue')
    .addIntegerOption((o) => o.setName('service').setDescription('Service-ID').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('link').setDescription('Ziel-Link').setRequired(true))
    .addIntegerOption((o) => o.setName('quantity').setDescription('Menge').setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName('runs').setDescription('Optional: Runs').setMinValue(1))
    .addIntegerOption((o) => o.setName('interval').setDescription('Optional: Intervall in Minuten').setMinValue(1)),
  new SlashCommandBuilder().setName('admin').setDescription('Admin Panel')
    .addSubcommand((s) => s.setName('panel').setDescription('Öffnet die Admin-Steuerung'))
    .addSubcommand((s) => s.setName('queue').setDescription('Zeigt die Queue'))
    .addSubcommand((s) => s.setName('pause').setDescription('Pausiert neue Bestellungen'))
    .addSubcommand((s) => s.setName('resume').setDescription('Setzt die Queue fort'))
    .addSubcommand((s) => s.setName('clear').setDescription('Entfernt fehlgeschlagene Queue-Einträge'))
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
  await rest.put(route, { body: commands });
}
function queueText() {
  const items = queue.snapshot().slice(-15);
  if (!items.length) return 'Die Queue ist leer.';
  return items.map((item) => `\`${item.id.slice(0, 8)}\` · **${item.status}** · User <@${item.userId}>${item.result?.order ? ` · Order ${item.result.order}` : ''}${item.error ? ` · ${safe(item.error)}` : ''}`).join('\n');
}
function orderModal() {
  return new ModalBuilder().setCustomId('order_modal').setTitle('Neue Bestellung').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('service').setLabel('Service-ID').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('link').setLabel('Ziel-Link').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('Menge').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('runs').setLabel('Runs (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('interval').setLabel('Intervall in Minuten (optional)').setStyle(TextInputStyle.Short).setRequired(false))
  );
}
function statusModal() {
  return new ModalBuilder().setCustomId('status_modal').setTitle('Bestellstatus').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('order').setLabel('Order-ID').setStyle(TextInputStyle.Short).setRequired(true)));
}
async function showServices(interaction) {
  const services = await api.services();
  const lines = services.slice(0, 25).map((service) => `**${service.service} · ${safe(service.name)}**\n${safe(service.category)} · ${service.min}-${service.max} · Rate ${service.rate}`);
  await interaction.reply({ content: lines.join('\n\n') || 'Keine Services gefunden.', ephemeral: true });
}
async function createOrder(interaction, order) {
  if (!allowed(interaction)) return interaction.reply({ content: 'Rate Limit erreicht. Bitte kurz warten.', ephemeral: true });
  const item = queue.enqueue({ userId: interaction.user.id, order });
  await interaction.reply({ content: `In Queue aufgenommen. Ticket: \`${item.id.slice(0, 8)}\``, ephemeral: true });
}

client.once(Events.ClientReady, async (readyClient) => {
  await registerCommands();
  console.log(`Eingeloggt als ${readyClient.user.tag}`);
});
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') return interaction.reply({ embeds: [panelEmbed()], components: panelRows() });
      if (interaction.commandName === 'services') return showServices(interaction);
      if (interaction.commandName === 'balance') { const result = await api.balance(); return interaction.reply({ content: `Guthaben: **${safe(result.balance)} ${safe(result.currency)}**`, ephemeral: true }); }
      if (interaction.commandName === 'status') { const result = await api.orderStatus(interaction.options.getString('order')); return interaction.reply({ content: `\`Status\` ${safe(result.status)} · Rest: ${safe(result.remains)} · Charge: ${safe(result.charge)}`, ephemeral: true }); }
      if (interaction.commandName === 'order') return createOrder(interaction, { service: interaction.options.getInteger('service'), link: interaction.options.getString('link'), quantity: interaction.options.getInteger('quantity'), runs: interaction.options.getInteger('runs'), interval: interaction.options.getInteger('interval') });
      if (interaction.commandName === 'admin') {
        if (!isAdmin(interaction)) return interaction.reply({ content: 'Keine Berechtigung.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'panel') return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Admin Panel').setColor(0xed4245).setDescription('Queue und Betriebsstatus verwalten.')], components: adminRows(), ephemeral: true });
        if (sub === 'queue') return interaction.reply({ content: queueText(), ephemeral: true });
        if (sub === 'pause') { queue.pause(); return interaction.reply({ content: 'Queue pausiert.', ephemeral: true }); }
        if (sub === 'resume') { queue.resume(); return interaction.reply({ content: 'Queue fortgesetzt.', ephemeral: true }); }
        if (sub === 'clear') { queue.clear(); return interaction.reply({ content: 'Fehlgeschlagene Einträge entfernt.', ephemeral: true }); }
      }
    }
    if (interaction.isButton()) {
      if (interaction.customId === 'panel_services') return showServices(interaction);
      if (interaction.customId === 'panel_order') return interaction.showModal(orderModal());
      if (interaction.customId === 'panel_status') return interaction.showModal(statusModal());
      if (interaction.customId === 'panel_balance') { const result = await api.balance(); return interaction.reply({ content: `Guthaben: **${safe(result.balance)} ${safe(result.currency)}**`, ephemeral: true }); }
      if (!isAdmin(interaction)) return interaction.reply({ content: 'Keine Berechtigung.', ephemeral: true });
      if (interaction.customId === 'admin_pause') { queue.pause(); return interaction.update({ content: 'Queue pausiert.', embeds: [], components: adminRows() }); }
      if (interaction.customId === 'admin_resume') { queue.resume(); return interaction.update({ content: 'Queue fortgesetzt.', embeds: [], components: adminRows() }); }
      if (interaction.customId === 'admin_queue') return interaction.reply({ content: queueText(), ephemeral: true });
      if (interaction.customId === 'admin_clear') { queue.clear(); return interaction.update({ content: 'Fehlgeschlagene Einträge entfernt.', embeds: [], components: adminRows() }); }
    }
    if (interaction.isModalSubmit() && interaction.customId === 'order_modal') {
      const number = (id) => Number(interaction.fields.getTextInputValue(id));
      const quantity = number('quantity');
      if (!Number.isInteger(number('service')) || !Number.isInteger(quantity) || quantity < 1) return interaction.reply({ content: 'Service-ID und Menge müssen gültige Zahlen sein.', ephemeral: true });
      return createOrder(interaction, { service: number('service'), link: interaction.fields.getTextInputValue('link'), quantity, runs: number('runs') || undefined, interval: number('interval') || undefined });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'status_modal') { const result = await api.orderStatus(interaction.fields.getTextInputValue('order')); return interaction.reply({ content: `\`Status\` ${safe(result.status)} · Rest: ${safe(result.remains)} · Charge: ${safe(result.charge)}`, ephemeral: true }); }
  } catch (error) {
    console.error(error);
    const content = errorText(error);
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true });
    else await interaction.reply({ content, ephemeral: true });
  }
});

client.login(config.token);
