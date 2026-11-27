const assert = require('assert');
const P = require('../parser.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS:', name);
    passed += 1;
  } catch (err) {
    console.error('FAIL:', name);
    console.error(err);
    process.exitCode = 1;
  }
}

// 1. Whatnot Title Case + Giveaways + Refunds + Tips + Shipping Charge
test('Whatnot Title Case Weekly Orders Report math and giveaway handling', () => {
  const res = P.parseResellerCSV(P.SAMPLES.whatnot.content, P.SAMPLES.whatnot.filename);
  assert.strictEqual(res.platform, 'whatnot');
  assert.strictEqual(res.ordersCount, 2);
  assert.strictEqual(res.giveawaysCount, 1);
  assert.strictEqual(res.canceledCount, 1);
  // Gross = 85 + 40 = 125; Tips = 10; 1099-K Gross = 135
  assert.strictEqual(res.grossSales, 125);
  assert.strictEqual(res.tips, 10);
  assert.strictEqual(res.estimated1099KGross, 135);
  // Fees = (6.80 + 3.15) + (3.20 + 1.67) = 14.82
  assert.strictEqual(res.platformFees, 14.82);
  // Shipping = 4.25 + 3.85 = 8.10; Giveaway = 4.47
  assert.strictEqual(res.shippingLabels, 8.1);
  assert.strictEqual(res.giveawayCosts, 4.47);
  // Refunds = 28.50
  assert.strictEqual(res.refunds, 28.5);
  // Net payout = 75.05 + 30.88 - 4.47 - 28.50 + 10.00 - 3.85 = 79.11
  assert.strictEqual(res.netPayout, 79.11);
});

// 2. Whatnot UPPER_SNAKE_CASE + ORIGINAL_ITEM_PRICE + COUPON_COST + fee tax residual
test('Whatnot UPPER_SNAKE_CASE + legacy coupon columns + fee tax detection', () => {
  const csv = [
    'TRANSACTION_COMPLETED_AT,ORDER_ID,TRANSACTION_TYPE,BUY_FORMAT,ORIGINAL_ITEM_PRICE,COUPON_COST,COMMISSION_FEE,PAYMENT_PROCESSING_FEE,SHIPPING_FEE,TRANSACTION_AMOUNT',
    '2026-11-20 12:00:00,W1,ORDER_EARNINGS,Auction,100.00,-10.00,7.20,3.10,0.00,79.20'
  ].join('\n');
  const res = P.parseResellerCSV(csv, 'whatnot_upper.csv');
  assert.strictEqual(res.platform, 'whatnot');
  assert.strictEqual(res.grossSales, 90);
  // Implied fees = 90 - 79.20 - 0 = 10.80 (includes $0.50 tax on fees beyond 7.20+3.10=10.30)
  assert.strictEqual(res.platformFees, 10.8);
  assert.strictEqual(res.netPayout, 79.2);
});

// 3. Poshmark 12 preamble rows + inferred fees (20% and $2.95 flat) + buyer sales tax excluded
test('Poshmark 12-row preamble skip + inferred fees + buyer tax exclusion', () => {
  const res = P.parseResellerCSV(P.SAMPLES.poshmark.content, P.SAMPLES.poshmark.filename);
  assert.strictEqual(res.platform, 'poshmark');
  assert.strictEqual(res.ordersCount, 3);
  // Gross = 70 + 13 + 120 = 203
  assert.strictEqual(res.grossSales, 203);
  // Fees: (70 - 2.02 - 53.98 = 14.00) + (13 - 10.05 = 2.95) + (120 - 4.50 - 91.50 = 24.00) = 40.95
  assert.strictEqual(res.platformFees, 40.95);
  // Shipping: 2.02 + 4.50 = 6.52
  assert.strictEqual(res.shippingLabels, 6.52);
  // Buyer tax: 6.65 + 1.15 + 9.90 = 17.70
  assert.strictEqual(res.buyerSalesTaxExcluded, 17.7);
  // Net: 53.98 + 10.05 + 91.50 = 155.53
  assert.strictEqual(res.netPayout, 155.53);
  assert.ok(res.warnings.some(w => w.message.includes('Skipped 12 Poshmark preamble')));
});

// 4. Poshmark 2025-2026 aliases: Net Earnings + Texas Seller Fee Tax
test('Poshmark Net Earnings alias and Texas Seller Fee Tax', () => {
  const csv = [
    'Order Date,Order ID,Listing Title,Order Price,Seller Shipping Discount,Upgraded Shipping Label Fee,Packaging Fee,Texas Seller Fee Tax,Net Earnings,Sales Tax (Paid by Buyer)',
    '11/20/2026,PM-9,Jacket,$50.00,$0.00,$0.00,$0.00,$0.83,$39.17,$4.13'
  ].join('\n');
  const res = P.parseResellerCSV(csv, 'poshmark_tx.csv');
  assert.strictEqual(res.platform, 'poshmark');
  assert.strictEqual(res.grossSales, 50);
  // Inferred fee = 50 - 0.83 - 39.17 = 10.00; total platformFees = 10.00 + 0.83 = 10.83
  assert.strictEqual(res.platformFees, 10.83);
  assert.strictEqual(res.netPayout, 39.17);
});

// 5. Mercari unescaped inch-mark quote recovery + Completed/Canceled split + ignore buyer-paid fees
test('Mercari unescaped inch-mark recovery, status split, and ignoring buyer-paid fees', () => {
  const res = P.parseResellerCSV(P.SAMPLES.mercari.content, P.SAMPLES.mercari.filename);
  assert.strictEqual(res.platform, 'mercari');
  assert.strictEqual(res.ordersCount, 2);
  assert.strictEqual(res.canceledCount, 1);
  // Gross item price = 45 + 38 = 83
  assert.strictEqual(res.grossSales, 83);
  // 1099-K Gross = 83 + 6.99 (buyer ship) + 6.29 (buyer tax) = 96.28
  assert.strictEqual(res.estimated1099KGross, 96.28);
  // Seller fees ONLY (ignore Buyer Protection Charged to Buyer 1.62 + 1.37!): 4.50 + 3.80 = 8.30
  assert.strictEqual(res.platformFees, 8.3);
  // Seller shipping + adjustment: 6.99 + 2.15 = 9.14
  assert.strictEqual(res.shippingLabels, 9.14);
  // Net proceeds: 40.50 + 25.06 = 65.56
  assert.strictEqual(res.netPayout, 65.56);
  assert.ok(res.warnings.some(w => w.message.includes('unescaped quote')));
});

// 6. Mercari missing empty-quote column shift warning (no silent misalignment)
test('Mercari shifted column count row is flagged and skipped safely', () => {
  const badCsv = P.SAMPLES.mercari.content + '\n"m1004","2026-11-24","Shifted Row","Completed","TX","OH","20.00"';
  const res = P.parseResellerCSV(badCsv, 'mercari_bad.csv');
  assert.strictEqual(res.ordersCount, 2);
  assert.ok(res.warnings.some(w => w.message.includes('instead of 20')));
});

// 7. Etsy Monthly Statement: 11 headers over 9 values, '--' cells, buyer tax subtracted, duplicate $0.20 listing fees preserved, Deposit excluded & parsed
test('Etsy Monthly Statement 11-over-9 rows, -- empty cells, tax subtraction, Deposit exclusion', () => {
  const res = P.parseResellerCSV(P.SAMPLES.etsy.content, P.SAMPLES.etsy.filename);
  assert.strictEqual(res.platform, 'etsy_statement');
  assert.strictEqual(res.ordersCount, 1);
  // Raw Sale = 58.40, Buyer Sales Tax = 4.40 -> Gross Sales = 54.00
  assert.strictEqual(res.estimated1099KGross, 58.4);
  assert.strictEqual(res.buyerSalesTaxExcluded, 4.4);
  assert.strictEqual(res.grossSales, 54);
  // Fees = 3.51 + 2.00 + 0.20 + 0.20 (BOTH listing fees kept!) = 5.91
  assert.strictEqual(res.platformFees, 5.91);
  // Marketing = 4.00, Shipping = 5.65
  assert.strictEqual(res.marketingFees, 4);
  assert.strictEqual(res.shippingLabels, 5.65);
  // Net = 58.40 - 4.40 - 5.91 - 5.65 - 4.00 = 38.44
  assert.strictEqual(res.netPayout, 38.44);
  // Deposit parsed from Title without double counting
  assert.strictEqual(res.bankDepositsReported, 38.44);
  assert.ok(res.warnings.some(w => w.message.includes('9 values under 11 headers')));
});

// 8. Etsy dynamic positive-fee sign convention handling
test('Etsy dynamic sign detection when Fee column uses positive charges', () => {
  const csv = [
    'Date,Type,Title,Info,Currency,Amount,Fees & Taxes,Net,Tax Details',
    '"November 20, 2026",Sale,Order #1,Order #1,USD,$50.00,--,$50.00,--',
    '"November 20, 2026",Fee,Transaction fee,Order #1,USD,--,$3.25,-$3.25,--',
    '"November 20, 2026",Fee,Credit for Transaction fee,Order #1,USD,--,-$0.25,$0.25,--'
  ].join('\n');
  const res = P.parseResellerCSV(csv, 'etsy_pos.csv');
  assert.strictEqual(res.platformFees, 3);
});

// 9. Unrecognized CSV triggers manual mapping fallback and parseManual works
test('Unrecognized CSV (e.g. Whatnot Ledger) triggers manual column mapper and reconciles', () => {
  const ledger = [
    'Created date,Description,Gross,Fee,Net',
    '2026-11-20,Payout batch,$100.00,-$12.00,$88.00'
  ].join('\n');
  const first = P.parseResellerCSV(ledger, 'whatnot_ledger.csv');
  assert.strictEqual(first.needsManualMapping, true);
  assert.deepStrictEqual(first.rawHeaders, ['Created date', 'Description', 'Gross', 'Fee', 'Net']);

  const mapped = P.parseManual(ledger, 'whatnot_ledger.csv', { gross: 2, fees: 3, shipping: -1, refunds: -1, net: 4 });
  assert.strictEqual(mapped.grossSales, 100);
  assert.strictEqual(mapped.platformFees, 12);
  assert.strictEqual(mapped.netPayout, 88);
});

// 10. Multi-CSV merge + duplicate filename warning + Schedule C CSV export
test('Multi-CSV merge combines all 4 platforms and builds Schedule C CSV', () => {
  const r1 = P.parseResellerCSV(P.SAMPLES.whatnot.content, 'whatnot.csv');
  const r2 = P.parseResellerCSV(P.SAMPLES.poshmark.content, 'poshmark.csv');
  const r3 = P.parseResellerCSV(P.SAMPLES.mercari.content, 'mercari.csv');
  const r4 = P.parseResellerCSV(P.SAMPLES.etsy.content, 'etsy.csv');
  const merged = P.mergeResults([r1, r2, r3, r4]);

  assert.strictEqual(merged.ordersCount, 8);
  assert.strictEqual(merged.grossSales, 465);
  assert.strictEqual(merged.netPayout, 338.64);

  const schedC = P.buildScheduleCCSV(merged, { totalCogs: 100, supplies: 15, otherExpenses: 5 });
  assert.ok(schedC.includes('Line 1,Gross receipts or sales,475.00'));
  assert.ok(schedC.includes('Line 4,Cost of goods sold (COGS),100.00'));
  assert.ok(schedC.includes('Line 31,Estimated Net Profit (Loss)'));

  const dup = P.mergeResults([r1, r1]);
  assert.ok(dup.warnings.some(w => w.message.includes('Duplicate filename')));
});

console.log('ALL ' + passed + ' TESTS PASSED');
