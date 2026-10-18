class BoostApiError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = 'BoostApiError';
    this.payload = payload;
  }
}

class BoostApiClient {
  constructor({ apiKey, apiUrl }) {
    if (!apiKey) throw new Error('BOOST_API_KEY is missing.');
    if (!apiUrl) throw new Error('BOOST_API_URL is missing.');
    if (apiUrl.includes('your-provider.example')) {
      throw new Error('BOOST_API_URL still uses the example placeholder. Set it to the real API endpoint, for example https://pandaboost.de/api/v2.');
    }
    try {
      const parsedUrl = new URL(apiUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported protocol');
    } catch {
      throw new Error('BOOST_API_URL must be a valid HTTP or HTTPS URL.');
    }
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  async request(action, params = {}) {
    const body = new URLSearchParams({ key: this.apiKey, action, ...params });
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new BoostApiError('The API returned invalid JSON.', text); }
    if (!response.ok) throw new BoostApiError(`API HTTP error ${response.status}.`, payload);
    if (payload?.error) throw new BoostApiError(payload.error, payload);
    return payload;
  }

  services() { return this.request('services'); }
  addOrder({ service, link, quantity, runs, interval }) {
    const params = { service: String(service), link: String(link), quantity: String(quantity) };
    if (runs) params.runs = String(runs);
    if (interval) params.interval = String(interval);
    return this.request('add', params);
  }
  orderStatus(order) { return this.request('status', { order: String(order) }); }
  ordersStatus(orders) { return this.request('status', { orders: orders.join(',') }); }
  refill(order) { return this.request('refill', { order: String(order) }); }
  refillStatus(refill) { return this.request('refill_status', { refill: String(refill) }); }
  cancel(orders) { return this.request('cancel', { orders: orders.join(',') }); }
  balance() { return this.request('balance'); }
}

module.exports = { BoostApiClient, BoostApiError };
