function roundMoney(value) {
  return Math.round(Number(value) * 100000000) / 100000000;
}

function normalizePricingConfig({ divisor = 1000, profitPercent = 0 } = {}) {
  const normalizedDivisor = Number(divisor);
  const normalizedProfit = Number(profitPercent);
  if (!Number.isFinite(normalizedDivisor) || normalizedDivisor <= 0) {
    throw new Error('CREDIT_RATE_DIVISOR must be a positive number.');
  }
  if (!Number.isFinite(normalizedProfit) || normalizedProfit < 0 || normalizedProfit > 100000) {
    throw new Error('PROFIT_PERCENT must be a number between 0 and 100000.');
  }
  return { divisor: normalizedDivisor, profitPercent: normalizedProfit };
}

function rateNumber(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Service rate must be a positive number.');
  return value;
}

function customerRate(rate, profitPercent = 0) {
  const value = rateNumber(rate);
  const profit = Number(profitPercent);
  if (!Number.isFinite(profit) || profit < 0) throw new Error('Profit percentage must be a non-negative number.');
  return roundMoney(value * (1 + profit / 100));
}

function orderCost(rate, quantity, runs = 1, { divisor = 1000, profitPercent = 0 } = {}) {
  const providerRate = rateNumber(rate);
  const units = Number(quantity);
  const runCount = Number(runs || 1);
  const pricing = normalizePricingConfig({ divisor, profitPercent });
  if (!Number.isFinite(units) || units <= 0) throw new Error('Quantity must be a positive number.');
  if (!Number.isFinite(runCount) || runCount <= 0) throw new Error('Runs must be a positive number.');
  return roundMoney(providerRate * units * runCount / pricing.divisor * (1 + pricing.profitPercent / 100));
}

function formatQuantity(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatMoney(value, currency = 'USD') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `Unavailable ${currency}`;
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${currency}`;
}

function formatUnit(divisor) {
  return `${formatQuantity(divisor)} units`;
}

module.exports = {
  customerRate,
  formatMoney,
  formatQuantity,
  formatUnit,
  normalizePricingConfig,
  orderCost,
  rateNumber,
  roundMoney
};
