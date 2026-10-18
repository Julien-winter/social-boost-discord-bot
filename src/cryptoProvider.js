class CryptoProviderError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'CryptoProviderError';
    this.status = status;
    this.payload = payload;
  }
}

class NowPaymentsProvider {
  constructor({ apiKey, ipnSecret, sandbox = false, currency = 'usd' }) {
    if (!apiKey) throw new Error('CRYPTO_API_KEY is missing.');
    if (!ipnSecret) throw new Error('CRYPTO_IPN_SECRET is missing.');
    this.apiKey = apiKey;
    this.ipnSecret = ipnSecret;
    this.currency = currency;
    this.baseUrl = sandbox ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1';
  }

  async request(path, options = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json', ...(options.headers || {}) }
      });
    } catch (error) {
      throw new CryptoProviderError(`Crypto provider request failed: ${error.message}`, undefined, undefined);
    }
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    if (!response.ok) throw new CryptoProviderError(`Crypto provider HTTP error ${response.status}.`, response.status, payload);
    return payload;
  }

  async createPayment({ amount, payCurrency, orderId, callbackUrl }) {
    return this.request('/payment', { method: 'POST', body: JSON.stringify({ price_amount: amount, price_currency: this.currency, pay_currency: payCurrency, order_id: orderId, ipn_callback_url: callbackUrl }) });
  }

  verifyIpnSignature(rawBody, signature) {
    const crypto = require('node:crypto');
    if (!signature) return false;
    let payload;
    try { payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { return false; }
    const stable = (value) => {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => { result[key] = stable(value[key]); return result; }, {});
      return value;
    };
    const expected = crypto.createHmac('sha512', this.ipnSecret).update(JSON.stringify(stable(payload))).digest('hex');
    if (expected.length !== String(signature).length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  }
}

module.exports = { NowPaymentsProvider, CryptoProviderError };
