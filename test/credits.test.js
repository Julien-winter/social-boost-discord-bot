const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CreditStore } = require('../src/credits');
const { NowPaymentsProvider } = require('../src/cryptoProvider');

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

test('NOWPayments signatures are verified over sorted JSON', () => {
  const provider = new NowPaymentsProvider({ apiKey: 'test', ipnSecret: 'secret' });
  const payload = { order_id: 'dep_1', payment_status: 'finished', price_amount: 10 };
  const stable = JSON.stringify(Object.keys(payload).sort().reduce((result, key) => { result[key] = payload[key]; return result; }, {}));
  const signature = crypto.createHmac('sha512', 'secret').update(stable).digest('hex');
  assert.equal(provider.verifyIpnSignature(JSON.stringify(payload), signature), true);
  assert.equal(provider.verifyIpnSignature(JSON.stringify(payload), 'invalid'), false);
});
