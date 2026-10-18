const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Amount must be a non-negative number.');
  return Math.round(number * 100000000) / 100000000;
}

class CreditStore {
  constructor(filePath, { currency = 'USD' } = {}) {
    this.filePath = path.resolve(filePath);
    this.currency = currency;
    this.state = this.#read();
    this.writeQueue = Promise.resolve();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { users: parsed.users || {}, deposits: parsed.deposits || {}, ledger: parsed.ledger || [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not read credits database: ${error.message}`);
      return { users: {}, deposits: {}, ledger: [] };
    }
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.filePath);
  }

  async #mutate(callback) {
    const operation = this.writeQueue.then(async () => {
      const result = await callback(this.state);
      this.#persist();
      return result;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  getBalance(userId) {
    return Number(this.state.users[String(userId)]?.balance || 0);
  }

  async reserve(userId, amount, metadata = {}) {
    const id = randomUUID();
    const value = money(amount);
    if (value <= 0) throw new Error('Order cost must be greater than zero.');
    return this.#mutate((state) => {
      const key = String(userId);
      const user = state.users[key] || { balance: 0 };
      if (user.balance + 1e-8 < value) {
        const error = new Error(`Insufficient credits. Required ${value.toFixed(2)} ${this.currency}; available ${Number(user.balance || 0).toFixed(2)} ${this.currency}.`);
        error.code = 'INSUFFICIENT_CREDITS';
        throw error;
      }
      user.balance = money(user.balance - value);
      state.users[key] = user;
      state.ledger.push({ id, userId: key, type: 'reserve', amount: -value, currency: this.currency, metadata, createdAt: new Date().toISOString() });
      return { id, amount: value, balance: user.balance };
    });
  }

  async refund(userId, reservationId, metadata = {}) {
    return this.#mutate((state) => {
      const existing = state.ledger.find((entry) => entry.id === reservationId && entry.type === 'reserve');
      if (!existing) return { refunded: false, balance: this.getBalance(userId) };
      if (existing.userId !== String(userId)) throw new Error('Reservation belongs to a different user.');
      if (state.ledger.some((entry) => entry.type === 'refund' && entry.metadata?.reservationId === reservationId)) return { refunded: false, balance: this.getBalance(userId) };
      const key = String(userId);
      const user = state.users[key] || { balance: 0 };
      user.balance = money(user.balance + Math.abs(existing.amount));
      state.users[key] = user;
      state.ledger.push({ id: randomUUID(), userId: key, type: 'refund', amount: Math.abs(existing.amount), currency: this.currency, metadata: { ...metadata, reservationId }, createdAt: new Date().toISOString() });
      return { refunded: true, balance: user.balance };
    });
  }

  async createDeposit(userId, amount, { provider = 'nowpayments', payCurrency = 'usdttrc20' } = {}) {
    const value = money(amount);
    if (value <= 0) throw new Error('Deposit amount must be greater than zero.');
    const id = `dep_${randomUUID()}`;
    return this.#mutate((state) => {
      const deposit = { id, userId: String(userId), amount: value, currency: this.currency, provider, payCurrency, status: 'pending', createdAt: new Date().toISOString() };
      state.deposits[id] = deposit;
      return { ...deposit };
    });
  }

  async attachProviderPayment(depositId, providerPaymentId, details = {}) {
    return this.#mutate((state) => {
      const deposit = state.deposits[depositId];
      if (!deposit) throw new Error('Deposit not found.');
      const providerId = String(providerPaymentId);
      const duplicate = Object.values(state.deposits).find((item) => item.id !== depositId && item.providerPaymentId === providerId);
      if (duplicate) throw new Error('Provider payment is already linked to another deposit.');
      deposit.providerPaymentId = providerId;
      Object.assign(deposit, details);
      return { ...deposit };
    });
  }

  getDeposit(depositId) {
    const deposit = this.state.deposits[String(depositId)];
    return deposit ? { ...deposit } : null;
  }

  async completeDeposit({ depositId, providerPaymentId, status, actualAmount, actualPayAmount }) {
    return this.#mutate((state) => {
      const deposit = Object.values(state.deposits).find((item) => item.id === depositId || (providerPaymentId && item.providerPaymentId === String(providerPaymentId)));
      if (!deposit) throw new Error('Deposit not found.');
      if (providerPaymentId && deposit.providerPaymentId && deposit.providerPaymentId !== String(providerPaymentId)) throw new Error('Provider payment does not match the deposit.');
      if (deposit.status === 'credited') return { credited: false, duplicate: true, balance: this.getBalance(deposit.userId) };
      deposit.status = String(status || '').toLowerCase();
      const paid = Number(actualAmount);
      const paidCrypto = Number(actualPayAmount);
      const successful = ['confirmed', 'finished', 'complete', 'completed'].includes(deposit.status);
      const expectedCrypto = Number(deposit.payAmount);
      const hasCryptoAmounts = Number.isFinite(expectedCrypto) && expectedCrypto > 0;
      const underpaidCrypto = hasCryptoAmounts && (!Number.isFinite(paidCrypto) || paidCrypto + 1e-8 < expectedCrypto);
      const underpaidFiat = !hasCryptoAmounts && (!Number.isFinite(paid) || paid + 1e-8 < deposit.amount);
      if (!successful || underpaidCrypto || underpaidFiat) {
        this.#persist();
        return { credited: false, pending: successful && (underpaidCrypto || underpaidFiat), balance: this.getBalance(deposit.userId) };
      }
      const user = state.users[deposit.userId] || { balance: 0 };
      user.balance = money(user.balance + deposit.amount);
      state.users[deposit.userId] = user;
      deposit.status = 'credited';
      deposit.creditedAt = new Date().toISOString();
      state.ledger.push({ id: randomUUID(), userId: deposit.userId, type: 'deposit', amount: deposit.amount, currency: deposit.currency, metadata: { depositId: deposit.id, providerPaymentId: deposit.providerPaymentId }, createdAt: new Date().toISOString() });
      return { credited: true, balance: user.balance, amount: deposit.amount };
    });
  }

  listDeposits(userId, limit = 10) {
    return Object.values(this.state.deposits).filter((item) => item.userId === String(userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((item) => ({ ...item }));
  }
}

module.exports = { CreditStore, money };
