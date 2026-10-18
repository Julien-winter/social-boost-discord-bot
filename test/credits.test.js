const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CreditStore } = require('../src/credits');
const { NowPaymentsProvider } = require('../src/cryptoProvider');
const { OrderQueue } = require('../src/queue');
const { BoostApiClient } = require('../src/apiClient');
const { customerRate, orderCost, normalizePricingConfig } = require('../src/pricing');
const { platformFromService, serviceMatches, servicePlatforms } = require('../src/serviceCatalog');

function tempFile() {
  return path.join(os.tmpdir(), `social-boost-credits-${process.pid}-${Date.now()}.json`);
}

test('credits are isolated per user and reservations can be refunded once', async () => {
  const file = tempFile();
  const store = new CreditStore(file);
  const deposit = await store.createDeposit('alice', 10);
  await store.completeDeposit({ depositId: deposit.id, status: 'finished', actualAmount: 10 });
  assert.equal(store.getBalance('alice'), 10);
  assert.equal(store.getBalance('bob'), 0);
  const reservation = await store.reserve('alice', 2, { ticket: 'a' });
  assert.equal(store.getBalance('alice'), 8);
  await store.refund('alice', reservation.id);
  await store.refund('alice', reservation.id);
  assert.equal(store.getBalance('alice'), 10);
  fs.rmSync(file, { force: true });
});

test('deposit webhook crediting is idempotent and rejects underpayment', async () => {
  const file = tempFile();
  const store = new CreditStore(file);
  const deposit = await store.createDeposit('alice', 10);
  const pending = await store.completeDeposit({ depositId: deposit.id, status: 'finished', actualAmount: 9 });
  assert.equal(pending.credited, false);
  assert.equal(store.getBalance('alice'), 0);
  const credited = await store.completeDeposit({ depositId: deposit.id, status: 'finished', actualAmount: 10 });
  assert.equal(credited.credited, true);
  const duplicate = await store.completeDeposit({ depositId: deposit.id, status: 'finished', actualAmount: 10 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.getBalance('alice'), 10);
  fs.rmSync(file, { force: true });
});

test('deposit confirmation validates the actual crypto amount', async () => {
  const file = tempFile();
  const store = new CreditStore(file);
  const deposit = await store.createDeposit('alice', 10, { payCurrency: 'usdttrc20' });
  await store.attachProviderPayment(deposit.id, 'payment-1', { payAmount: '0.25', payCurrency: 'usdttrc20' });
  const underpaid = await store.completeDeposit({ depositId: deposit.id, providerPaymentId: 'payment-1', status: 'finished', actualAmount: 10, actualPayAmount: 0.24 });
  assert.equal(underpaid.credited, false);
  assert.equal(store.getBalance('alice'), 0);
  const credited = await store.completeDeposit({ depositId: deposit.id, providerPaymentId: 'payment-1', status: 'finished', actualAmount: 10, actualPayAmount: 0.25 });
  assert.equal(credited.credited, true);
  assert.equal(store.getBalance('alice'), 10);
  fs.rmSync(file, { force: true });
});

test('credit mutations reject cross-user reservations and duplicate payment links', async () => {
  const file = tempFile();
  const store = new CreditStore(file);
  const deposit = await store.createDeposit('alice', 10);
  await store.completeDeposit({ depositId: deposit.id, status: 'finished', actualAmount: 10 });
  const reservation = await store.reserve('alice', 2);
  await assert.rejects(() => store.refund('bob', reservation.id), /different user/);
  const other = await store.createDeposit('bob', 5);
  await store.attachProviderPayment(deposit.id, 'payment-unique');
  await assert.rejects(() => store.attachProviderPayment(other.id, 'payment-unique'), /already linked/);
  fs.rmSync(file, { force: true });
});

test('NOWPayments signatures are verified over sorted JSON', () => {
  const provider = new NowPaymentsProvider({ apiKey: 'test', ipnSecret: 'secret' });
  const payload = { order_id: 'dep_1', payment_status: 'finished', price_amount: 10 };
  const stable = JSON.stringify(Object.keys(payload).sort().reduce((result, key) => { result[key] = payload[key]; return result; }, {}));
  const signature = crypto.createHmac('sha512', 'secret').update(stable).digest('hex');
  assert.equal(provider.verifyIpnSignature(JSON.stringify(payload), signature), true);
  assert.equal(provider.verifyIpnSignature(JSON.stringify(payload), 'invalid'), false);
});

test('queue clear removes only failed items', async () => {
  const api = { addOrder: async () => ({ order: 123 }) };
  const queue = new OrderQueue(api);
  const queued = queue.enqueue({ userId: 'alice', order: { service: 1, link: 'https://example.com', quantity: 1 } });
  queue.items.push({ id: 'failed', status: 'failed' });
  queue.clear();
  assert.equal(queue.find('failed'), undefined);
  assert.ok(queue.find(queued.id));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(queue.find(queued.id).status, 'completed');
});

test('API client rejects placeholder and invalid endpoints', () => {
  assert.throws(() => new BoostApiClient({ apiKey: 'key', apiUrl: 'https://your-provider.example/api/v2' }), /placeholder/);
  assert.throws(() => new BoostApiClient({ apiKey: 'key', apiUrl: 'file:///tmp/api' }), /valid HTTP or HTTPS/);
});

test('reseller pricing applies the configured profit margin consistently', () => {
  assert.equal(customerRate(1.5, 20), 1.8);
  assert.equal(orderCost(1.5, 1000, 1, { divisor: 1000, profitPercent: 20 }), 1.8);
  assert.equal(orderCost(1.5, 2500, 2, { divisor: 1000, profitPercent: 20 }), 9);
  assert.deepEqual(normalizePricingConfig({ divisor: 1000, profitPercent: 25 }), { divisor: 1000, profitPercent: 25 });
  assert.throws(() => normalizePricingConfig({ divisor: 1000, profitPercent: -1 }), /between 0/);
});

test('service catalog detects and filters platforms', () => {
  const services = [
    { service: 1, name: 'TikTok followers', category: 'Social' },
    { service: 2, name: 'YouTube views', category: 'Video' },
    { service: 3, name: 'Twitch live viewers', category: 'Streaming' }
  ];
  assert.equal(platformFromService(services[0]), 'TikTok');
  assert.deepEqual(servicePlatforms(services), ['TikTok', 'Twitch', 'YouTube']);
  assert.equal(serviceMatches(services[0], { platform: 'TikTok' }), true);
  assert.equal(serviceMatches(services[1], { platform: 'TikTok' }), false);
});
