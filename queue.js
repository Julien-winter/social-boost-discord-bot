const { randomUUID } = require('node:crypto');
const EventEmitter = require('node:events');

class OrderQueue extends EventEmitter {
  constructor(api, { concurrency = 1, onFailed } = {}) {
    super();
    this.api = api;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.items = [];
    this.running = 0;
    this.paused = false;
    this.onFailed = onFailed;
  }

  enqueue(payload) {
    const item = { id: randomUUID(), ...payload, status: 'queued', createdAt: new Date().toISOString() };
    this.items.push(item);
    this.emit('changed');
    this.#drain();
    return item;
  }

  pause() { this.paused = true; this.emit('changed'); }
  resume() { this.paused = false; this.#drain(); this.emit('changed'); }
  clear() { this.items = this.items.filter((item) => item.status === 'processing'); this.emit('changed'); }
  snapshot() { return this.items.map((item) => ({ ...item })); }
  find(id) { return this.items.find((item) => item.id === id); }

  async #drain() {
    if (this.paused) return;
    while (!this.paused && this.running < this.concurrency) {
      const item = this.items.find((candidate) => candidate.status === 'queued');
      if (!item) return;
      this.running += 1;
      item.status = 'processing';
      item.startedAt = new Date().toISOString();
      this.emit('changed');
      this.#process(item).finally(() => {
        this.running -= 1;
        this.#drain();
      });
    }
  }

  async #process(item) {
    try {
      const result = await this.api.addOrder(item.order);
      item.status = 'completed';
      item.result = result;
      item.finishedAt = new Date().toISOString();
      this.emit('completed', item);
    } catch (error) {
      item.status = 'failed';
      item.error = error.message;
      if (item.reservationId && this.onFailed) {
        try { await this.onFailed(item); } catch (refundError) { item.refundError = refundError.message; }
      }
      item.finishedAt = new Date().toISOString();
      this.emit('failed', item);
    }
    this.emit('changed');
  }
}

module.exports = { OrderQueue };
