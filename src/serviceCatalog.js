function platformFromService(service) {
  const text = `${service.name || ''} ${service.category || ''} ${service.type || ''}`.toLowerCase();
  if (/tiktok|tik tok/.test(text)) return 'TikTok';
  if (/youtube|\byt\b/.test(text)) return 'YouTube';
  if (/twitch/.test(text)) return 'Twitch';
  if (/instagram|\binsta\b/.test(text)) return 'Instagram';
  if (/facebook|\bfb\b/.test(text)) return 'Facebook';
  if (/twitter|\bx\s*(followers|likes|views|retweet|tweet)/.test(text)) return 'X / Twitter';
  if (/telegram/.test(text)) return 'Telegram';
  if (/spotify/.test(text)) return 'Spotify';
  return 'Other';
}

function servicePlatforms(services) {
  return [...new Set(services.map(platformFromService))].sort((a, b) => a.localeCompare(b));
}

function serviceMatches(service, { platform = null, category = null, query = '' } = {}) {
  const inPlatform = !platform || platformFromService(service) === platform;
  const inCategory = !category || String(service.category || 'Other') === category;
  const haystack = `${service.service} ${service.name || ''} ${service.category || ''} ${service.type || ''}`.toLowerCase();
  return inPlatform && inCategory && (!query || haystack.includes(query));
}

module.exports = { platformFromService, serviceMatches, servicePlatforms };
