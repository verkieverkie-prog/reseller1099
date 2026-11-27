// Reseller1099 browser-local CSV parser engine
// Works in both browser (window.ResellerParser) and Node.js (module.exports)

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ResellerParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function normalizeHeader(h) {
    return String(h || '')
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function parseMoney(val) {
    if (val === null || val === undefined) return 0;
    let s = String(val).trim();
    if (!s || s === '--' || s === '-' || s.toLowerCase() === 'n/a') return 0;
    let negative = false;
    if (s.startsWith('(') && s.endsWith(')')) {
      negative = true;
      s = s.slice(1, -1).trim();
    }
    if (s.startsWith('-')) {
      negative = true;
      s = s.slice(1).trim();
    }
    // Strip currency symbols, letters, commas, spaces
    s = s.replace(/[^0-9.\-]/g, '');
    if (!s || s === '.' || s === '-') return 0;
    let num = parseFloat(s);
    if (Number.isNaN(num)) return 0;
    if (negative && num > 0) num = -num;
    return num;
  }

  // Lenient RFC-4180 CSV parser with quote recovery for Mercari unescaped inch-marks
  function parseCSVText(text) {
    const cleanText = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    const warnings = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let rowIndex = 1;
    let i = 0;
    const len = cleanText.length;

    while (i < len) {
      const ch = cleanText[i];

      if (inQuotes) {
        if (ch === '"') {
          const next = cleanText[i + 1];
          if (next === '"') {
            // Escaped quote ""
            // Edge case: Mercari sometimes writes 20"" x 20" inside a quoted field
            field += '"';
            i += 2;
            continue;
          }
          // Check if this quote legitimately closes the field (followed by comma, newline, or EOF, allowing trailing spaces)
          let j = i + 1;
          while (j < len && cleanText[j] === ' ') j++;
          const after = cleanText[j];
          if (after === ',' || after === '\n' || after === '\r' || j >= len) {
            inQuotes = false;
            i = j;
            continue;
          }
          // Otherwise, this is an unescaped quote inside a quoted field (e.g., 20" linen)
          warnings.push({
            row: rowIndex,
            message: 'Recovered unescaped quote inside a quoted field (common in Mercari item titles).'
          });
          field += '"';
          i += 1;
          continue;
        } else {
          field += ch;
          i += 1;
          continue;
        }
      } else {
        if (ch === '"' && field.length === 0) {
          inQuotes = true;
          i += 1;
          continue;
        }
        if (ch === ',') {
          row.push(field);
          field = '';
          i += 1;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          row.push(field);
          rows.push({ lineNumber: rowIndex, cells: row });
          row = [];
          field = '';
          rowIndex += 1;
          if (ch === '\r' && cleanText[i + 1] === '\n') {
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        field += ch;
        i += 1;
      }
    }

    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push({ lineNumber: rowIndex, cells: row });
    }

    // Deduplicate identical per-row quote warnings
    const seenWarn = new Set();
    const dedupedWarnings = warnings.filter(function (w) {
      const key = w.row + ':' + w.message;
      if (seenWarn.has(key)) return false;
      seenWarn.add(key);
      return true;
    });

    return { rows: rows, warnings: dedupedWarnings };
  }

  function hasAny(headerSet, names) {
    for (let i = 0; i < names.length; i++) {
      if (headerSet.has(names[i])) return true;
    }
    return false;
  }

  function detectPlatformFromHeaders(normHeaders) {
    const set = new Set(normHeaders.filter(Boolean));
    if (set.size < 3) return null;

    // 1. Whatnot Weekly Orders Report
    if (
      set.has('transaction_type') &&
      hasAny(set, ['transaction_amount', 'post_coupon_price', 'original_item_price', 'commission_fee'])
    ) {
      return 'whatnot';
    }

    // 2. Poshmark My Sales Report
    if (
      set.has('order_price') &&
      hasAny(set, ['your_earnings', 'net_earnings']) &&
      hasAny(set, ['order_date', 'listing_title', 'order_id'])
    ) {
      return 'poshmark';
    }

    // 3. Mercari Gross Sales Report
    if (
      set.has('order_status') &&
      set.has('item_price') &&
      set.has('net_seller_proceeds')
    ) {
      return 'mercari';
    }

    // 4. Etsy Monthly Payment Account Statement
    if (
      set.has('type') &&
      set.has('title') &&
      set.has('amount') &&
      hasAny(set, ['fees_taxes', 'fees_and_taxes']) &&
      set.has('net')
    ) {
      return 'etsy_statement';
    }

    // 4b. Secondary Etsy Payments Sales CSV
    if (set.has('gross_amount') && set.has('fees') && set.has('net_amount')) {
      return 'etsy_payments';
    }

    // 4c. Secondary Etsy Sold Orders CSV
    if (set.has('order_value') && set.has('order_total') && hasAny(set, ['order_net', 'card_processing_fees'])) {
      return 'etsy_orders';
    }

    return null;
  }

  // Scan up to 25 rows to locate a known header row (handles Poshmark's 12 preamble rows)
  function findHeaderRow(rows) {
    const maxScan = Math.min(rows.length, 25);
    for (let i = 0; i < maxScan; i++) {
      const norm = rows[i].cells.map(normalizeHeader);
      const platform = detectPlatformFromHeaders(norm);
      if (platform) {
        return {
          headerIndex: i,
          lineNumber: rows[i].lineNumber,
          rawHeaders: rows[i].cells.map(function (c) { return String(c || '').trim(); }),
          normHeaders: norm,
          platform: platform
        };
      }
    }
    // Fallback: pick first non-empty row with >= 2 cells
    for (let i = 0; i < maxScan; i++) {
      const nonEmpty = rows[i].cells.filter(function (c) { return String(c || '').trim() !== ''; });
      if (nonEmpty.length >= 2) {
        return {
          headerIndex: i,
          lineNumber: rows[i].lineNumber,
          rawHeaders: rows[i].cells.map(function (c) { return String(c || '').trim(); }),
          normHeaders: rows[i].cells.map(normalizeHeader),
          platform: 'unknown'
        };
      }
    }
    return null;
  }

  function makeRowGetter(normHeaders) {
    const idxMap = {};
    for (let i = 0; i < normHeaders.length; i++) {
      if (normHeaders[i] && idxMap[normHeaders[i]] === undefined) {
        idxMap[normHeaders[i]] = i;
      }
    }
    return function get(cells, aliases) {
      for (let i = 0; i < aliases.length; i++) {
        const idx = idxMap[aliases[i]];
        if (idx !== undefined && idx < cells.length) {
          return cells[idx];
        }
      }
      return '';
    };
  }

  function isBlankRow(cells) {
    if (!cells || cells.length === 0) return true;
    for (let i = 0; i < cells.length; i++) {
      if (String(cells[i] || '').trim() !== '') return false;
    }
    return true;
  }

  function emptyResult(platform, platformLabel, filename) {
    return {
      filename: filename || 'upload.csv',
      platform: platform,
      platformLabel: platformLabel,
      rowsParsed: 0,
      ordersCount: 0,
      canceledCount: 0,
      inProgressCount: 0,
      giveawaysCount: 0,
      estimated1099KGross: 0,
      grossSales: 0,
      tips: 0,
      platformFees: 0,
      marketingFees: 0,
      shippingLabels: 0,
      giveawayCosts: 0,
      refunds: 0,
      buyerSalesTaxExcluded: 0,
      cogsFromCsv: 0,
      netPayout: 0,
      bankDepositsReported: null,
      effectiveTakeRatePct: 0,
      mismatchGap: 0,
      mismatchNote: '',
      warnings: [],
      rawHeaders: []
    };
  }

  function finalizeResult(res) {
    res.estimated1099KGross = round2(res.estimated1099KGross);
    res.grossSales = round2(res.grossSales);
    res.tips = round2(res.tips);
    res.platformFees = round2(res.platformFees);
    res.marketingFees = round2(res.marketingFees);
    res.shippingLabels = round2(res.shippingLabels);
    res.giveawayCosts = round2(res.giveawayCosts);
    res.refunds = round2(res.refunds);
    res.buyerSalesTaxExcluded = round2(res.buyerSalesTaxExcluded);
    res.cogsFromCsv = round2(res.cogsFromCsv);
    res.netPayout = round2(res.netPayout);
    if (res.bankDepositsReported !== null) {
      res.bankDepositsReported = round2(res.bankDepositsReported);
    }
    const baseGross = res.grossSales + res.tips;
    const totalCosts = res.platformFees + res.marketingFees + res.shippingLabels + res.giveawayCosts;
    res.effectiveTakeRatePct = baseGross > 0 ? round2((totalCosts / baseGross) * 100) : 0;
    res.mismatchGap = round2(res.estimated1099KGross - res.netPayout);
    return res;
  }

  function parseWhatnot(dataRows, normHeaders, filename, baseWarnings) {
    const res = emptyResult('whatnot', 'Whatnot (Weekly Orders Report)', filename);
    res.warnings = baseWarnings.slice();
    const get = makeRowGetter(normHeaders);

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i].cells;
      if (isBlankRow(cells)) continue;
      res.rowsParsed += 1;

      const txTypeRaw = String(get(cells, ['transaction_type']) || '').trim();
      const txType = normalizeHeader(txTypeRaw);
      const buyFormat = normalizeHeader(get(cells, ['buy_format']));
      const txAmount = parseMoney(get(cells, ['transaction_amount']));
      const postCouponRaw = get(cells, ['post_coupon_price']);
      const origPrice = parseMoney(get(cells, ['original_item_price']));
      const couponCost = parseMoney(get(cells, ['coupon_cost']));
      const postCoupon = String(postCouponRaw || '').trim() !== ''
        ? parseMoney(postCouponRaw)
        : (origPrice !== 0 ? round2(origPrice + couponCost) : 0);

      const commFee = Math.abs(parseMoney(get(cells, ['commission_fee'])));
      const procFee = Math.abs(parseMoney(get(cells, ['payment_processing_fee'])));
      const shipFee = Math.abs(parseMoney(get(cells, ['shipping_fee'])));
      const cogs = Math.abs(parseMoney(get(cells, ['cost_of_goods'])));

      if (txType === 'order_earnings') {
        if (buyFormat === 'giveaway' || (postCoupon === 0 && txAmount < 0)) {
          res.giveawaysCount += 1;
          res.giveawayCosts += Math.abs(txAmount);
          res.netPayout += txAmount;
        } else {
          res.ordersCount += 1;
          res.grossSales += postCoupon;
          res.shippingLabels += shipFee;
          res.cogsFromCsv += cogs;
          res.netPayout += txAmount;

          // Never subtract fees from Transaction Amount; infer fee tax if implied fees exceed explicit commission + processing
          const explicitFees = commFee + procFee;
          const impliedFees = round2(postCoupon - txAmount - shipFee);
          if (impliedFees > explicitFees + 0.01) {
            res.platformFees += impliedFees;
          } else {
            res.platformFees += explicitFees;
          }
        }
      } else if (txType === 'order_refund') {
        res.canceledCount += 1;
        res.refunds += Math.abs(txAmount);
        res.netPayout += txAmount;
      } else if (txType === 'tips') {
        res.tips += txAmount;
        res.netPayout += txAmount;
      } else if (txType === 'shipping_charge') {
        res.shippingLabels += Math.abs(txAmount);
        res.netPayout += txAmount;
      } else if (txType) {
        res.warnings.push({
          row: dataRows[i].lineNumber,
          message: 'Unrecognized Whatnot Transaction Type "' + txTypeRaw + '" skipped from totals.'
        });
      }
    }

    res.estimated1099KGross = res.grossSales + res.tips;
    res.mismatchNote = 'Whatnot Transaction Amount is already net of fees and shipping. Your 1099-K reports gross sales (Post Coupon Price + Tips) before Whatnot commission, processing fees, seller shipping labels, giveaway labels, and refunds.';
    return finalizeResult(res);
  }

  function parsePoshmark(dataRows, normHeaders, filename, baseWarnings, headerLineNumber) {
    const res = emptyResult('poshmark', 'Poshmark (My Sales Report)', filename);
    res.warnings = baseWarnings.slice();
    if (headerLineNumber > 1) {
      res.warnings.push({
        row: headerLineNumber,
        message: 'Skipped ' + (headerLineNumber - 1) + ' Poshmark preamble/disclaimer rows before the header.'
      });
    }
    const get = makeRowGetter(normHeaders);

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i].cells;
      if (isBlankRow(cells)) continue;
      const orderPrice = parseMoney(get(cells, ['order_price']));
      const netEarnings = parseMoney(get(cells, ['your_earnings', 'net_earnings']));
      const orderDate = String(get(cells, ['order_date']) || '').trim();
      if (!orderDate && orderPrice === 0 && netEarnings === 0) continue;

      res.rowsParsed += 1;
      res.ordersCount += 1;

      const shipDisc = Math.abs(parseMoney(get(cells, ['seller_shipping_discount'])));
      const shipUpgrade = Math.abs(parseMoney(get(cells, ['upgraded_shipping_label_fee'])));
      const pkgFee = Math.abs(parseMoney(get(cells, ['packaging_fee'])));
      const txFeeTax = Math.abs(parseMoney(get(cells, ['texas_seller_fee_tax'])));
      const buyerTax = Math.abs(parseMoney(get(cells, ['sales_tax_paid_by_buyer'])));
      const cogs = Math.abs(parseMoney(get(cells, ['cost_price'])));

      // Poshmark CSV has no fee column; infer exact Poshmark fee per row
      const inferredFee = Math.max(0, round2(orderPrice - shipDisc - shipUpgrade - pkgFee - txFeeTax - netEarnings));

      res.grossSales += orderPrice;
      res.platformFees += inferredFee + txFeeTax;
      res.shippingLabels += shipDisc + shipUpgrade + pkgFee;
      res.buyerSalesTaxExcluded += buyerTax;
      res.cogsFromCsv += cogs;
      res.netPayout += netEarnings;
    }

    res.estimated1099KGross = res.grossSales;
    res.mismatchNote = 'Poshmark has no fee column in its CSV, so fees are inferred from Order Price minus shipping discounts, upgrades, and Your/Net Earnings. Note: My Sales Report only includes completed orders, whereas Poshmark 1099-K reports unadjusted gross before fees, shipping discounts, cancellations, and refunds.';
    return finalizeResult(res);
  }

  function parseMercari(dataRows, normHeaders, filename, baseWarnings) {
    const res = emptyResult('mercari', 'Mercari (Gross Sales Report)', filename);
    res.warnings = baseWarnings.slice();
    const expectedCols = normHeaders.length;
    const get = makeRowGetter(normHeaders);

    let buyerShippingTotal = 0;
    let merchantBuyerFeesTotal = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i].cells;
      if (isBlankRow(cells)) continue;

      if (cells.length !== expectedCols) {
        res.warnings.push({
          row: dataRows[i].lineNumber,
          message: 'Row has ' + cells.length + ' columns instead of ' + expectedCols + ' (Mercari sometimes omits empty date quotes). Skipped to prevent misaligned money totals.'
        });
        continue;
      }

      res.rowsParsed += 1;
      const status = String(get(cells, ['order_status']) || '').trim().toLowerCase();

      if (status === 'completed') {
        res.ordersCount += 1;
        const itemPrice = parseMoney(get(cells, ['item_price']));
        const buyerShip = Math.abs(parseMoney(get(cells, ['buyer_shipping_fee'])));
        const sellerShip = Math.abs(parseMoney(get(cells, ['seller_shipping_fee'])));
        const sellingFee = Math.abs(parseMoney(get(cells, ['mercari_selling_fee'])));
        const procFee = Math.abs(parseMoney(get(cells, ['payment_processing_fee'])));
        const shipAdj = Math.abs(parseMoney(get(cells, ['shipping_adjustment_fee'])));
        const netProceeds = parseMoney(get(cells, ['net_seller_proceeds']));
        const buyerTax = Math.abs(parseMoney(get(cells, ['sales_tax_charged_to_buyer'])));
        const merchantBuyerFee = Math.abs(parseMoney(get(cells, ['merchant_fees_charged_to_buyer'])));

        res.grossSales += itemPrice;
        buyerShippingTotal += buyerShip;
        merchantBuyerFeesTotal += merchantBuyerFee;
        res.buyerSalesTaxExcluded += buyerTax;
        res.platformFees += sellingFee + procFee;
        res.shippingLabels += sellerShip + shipAdj;
        res.netPayout += netProceeds;
      } else if (status === 'canceled' || status === 'cancelled') {
        res.canceledCount += 1;
      } else if (status === 'in progress' || status === 'pending') {
        res.inProgressCount += 1;
      } else if (status) {
        res.warnings.push({
          row: dataRows[i].lineNumber,
          message: 'Unrecognized Mercari Order Status "' + status + '" skipped.'
        });
      }
    }

    res.estimated1099KGross = res.grossSales + buyerShippingTotal + res.buyerSalesTaxExcluded + merchantBuyerFeesTotal;
    res.mismatchNote = 'Mercari 1099-K gross includes Item Price + Buyer Shipping + Buyer Sales Tax + Merchant Buyer Fees on Completed orders before subtracting Mercari Selling Fees, Processing Fees, Seller Shipping, and Shipping Adjustments. Buyer-paid fee columns are excluded from your seller fees.';
    return finalizeResult(res);
  }

  function parseEtsyStatement(dataRows, normHeaders, filename, baseWarnings) {
    const res = emptyResult('etsy_statement', 'Etsy (Monthly Payment Account Statement)', filename);
    res.warnings = baseWarnings.slice();
    const get = makeRowGetter(normHeaders);

    // Dynamic sign detection on Fee rows (ignoring credits)
    let negFeeCount = 0;
    let posFeeCount = 0;
    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i].cells;
      if (isBlankRow(cells)) continue;
      const type = String(get(cells, ['type']) || '').trim().toLowerCase();
      const title = String(get(cells, ['title']) || '').trim().toLowerCase();
      if (type === 'fee' && !title.includes('credit')) {
        const v = parseMoney(get(cells, ['fees_taxes', 'fees_and_taxes']));
        if (v < 0) negFeeCount++;
        else if (v > 0) posFeeCount++;
      }
    }
    // Standard Etsy: charges are negative, credits are positive -> chargeAmount = -val
    const chargesAreNegative = negFeeCount >= posFeeCount;
    function toCharge(val) {
      return chargesAreNegative ? -val : val;
    }

    let rawSaleAmount = 0;
    let buyerTaxCollected = 0;
    let buyerTaxRefunded = 0;
    let depositsTotal = 0;
    let sawDeposits = false;
    let shortRowCount = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i].cells;
      if (isBlankRow(cells)) continue;
      if (cells.length < normHeaders.length && normHeaders.length >= 11 && cells.length === 9) {
        shortRowCount += 1;
      }

      res.rowsParsed += 1;
      const type = String(get(cells, ['type']) || '').trim().toLowerCase();
      const title = String(get(cells, ['title']) || '').trim();
      const titleLower = title.toLowerCase();
      const amount = parseMoney(get(cells, ['amount']));
      const feesTaxes = parseMoney(get(cells, ['fees_taxes', 'fees_and_taxes']));
      const net = parseMoney(get(cells, ['net']));

      if (type === 'deposit' || type === 'payment') {
        // Exclude from revenue/fees/net; parse bank transfer figure from Title if present
        const m = title.match(/[\$€£]\s*([0-9,]+\.\d{2})/);
        if (m) {
          depositsTotal += parseFloat(m[1].replace(/,/g, ''));
          sawDeposits = true;
        }
        continue;
      }

      if (type === 'sale') {
        res.ordersCount += 1;
        rawSaleAmount += amount;
        res.netPayout += (net !== 0 ? net : amount);
      } else if (type === 'tax') {
        if (titleLower.includes('sales tax paid by buyer')) {
          buyerTaxCollected += Math.abs(feesTaxes);
          res.netPayout += (net !== 0 ? net : feesTaxes);
        } else if (titleLower.includes('refund to buyer for sales tax')) {
          buyerTaxRefunded += Math.abs(feesTaxes);
          res.netPayout += (net !== 0 ? net : feesTaxes);
        } else {
          // Deductible tax on Etsy fee (e.g. "Tax: Transaction")
          res.platformFees += toCharge(feesTaxes);
          res.netPayout += (net !== 0 ? net : feesTaxes);
        }
      } else if (type === 'fee' || type === 'vat') {
        res.platformFees += toCharge(feesTaxes);
        res.netPayout += (net !== 0 ? net : feesTaxes);
      } else if (type === 'marketing') {
        res.marketingFees += toCharge(feesTaxes);
        res.netPayout += (net !== 0 ? net : feesTaxes);
      } else if (type === 'shipping') {
        res.shippingLabels += toCharge(feesTaxes);
        res.netPayout += (net !== 0 ? net : feesTaxes);
      } else if (type === 'refund') {
        res.canceledCount += 1;
        res.refunds += Math.abs(amount);
        res.netPayout += (net !== 0 ? net : amount);
      } else if (type) {
        res.warnings.push({
          row: dataRows[i].lineNumber,
          message: 'Unrecognized Etsy row type "' + type + '" ignored.'
        });
      }
    }

    if (shortRowCount > 0) {
      res.warnings.push({
        row: 0,
        message: 'Handled ' + shortRowCount + ' Etsy 2026 rows with 9 values under 11 headers cleanly.'
      });
    }

    res.buyerSalesTaxExcluded = Math.max(0, round2(buyerTaxCollected - buyerTaxRefunded));
    res.grossSales = round2(rawSaleAmount - res.buyerSalesTaxExcluded);
    res.estimated1099KGross = round2(rawSaleAmount);
    if (sawDeposits) {
      res.bankDepositsReported = round2(depositsTotal);
    }
    res.mismatchNote = 'Etsy Sale rows include buyer-paid sales tax, which is subtracted out here so you do not overstate revenue. Deposit/Payment transfer rows are excluded from totals to prevent double-counting. Identical $0.20 listing fee rows are preserved.';
    return finalizeResult(res);
  }

  function parseEtsyBasic(platform, dataRows, normHeaders, filename, baseWarnings) {
    const label = platform === 'etsy_payments'
      ? 'Etsy (Payments Sales CSV - Basic Mode)'
      : 'Etsy (Sold Orders CSV - Basic Mode)';
    const res = emptyResult(platform, label, filename);
    res.warnings = baseWarnings.slice();
    res.warnings.push({
      row: 0,
      message: 'For full listing fees, Etsy Ads, Offsite Ads, and shipping labels, download Monthly Statements from Shop Manager -> Finances -> Monthly statements.'
    });
    const get = makeRowGetter(normHeaders);

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i].cells;
      if (isBlankRow(cells)) continue;
      res.rowsParsed += 1;
      res.ordersCount += 1;
      if (platform === 'etsy_payments') {
        const gross = parseMoney(get(cells, ['gross_amount']));
        const fees = Math.abs(parseMoney(get(cells, ['fees'])));
        const refund = Math.abs(parseMoney(get(cells, ['refund_amount'])));
        const net = parseMoney(get(cells, ['net_amount']));
        res.grossSales += gross;
        res.platformFees += fees;
        res.refunds += refund;
        res.netPayout += net;
      } else {
        const gross = parseMoney(get(cells, ['order_total', 'order_value']));
        const tax = Math.abs(parseMoney(get(cells, ['sales_tax'])));
        const fees = Math.abs(parseMoney(get(cells, ['card_processing_fees'])));
        const net = parseMoney(get(cells, ['order_net']));
        res.grossSales += round2(gross - tax);
        res.buyerSalesTaxExcluded += tax;
        res.platformFees += fees;
        res.netPayout += net;
      }
    }
    res.estimated1099KGross = round2(res.grossSales + res.buyerSalesTaxExcluded);
    res.mismatchNote = 'Parsed from secondary Etsy export. Upload Monthly Statements (etsy_statement_YYYY_M.csv) to include listing fees, shipping labels, and Etsy Ads.';
    return finalizeResult(res);
  }

  function parseManual(text, filename, mapping) {
    const parsed = parseCSVText(text);
    const headerInfo = findHeaderRow(parsed.rows);
    if (!headerInfo) {
      throw new Error('Could not find a header row in this CSV.');
    }
    const res = emptyResult('manual', 'Custom Mapped CSV', filename);
    res.warnings = parsed.warnings.slice();
    res.rawHeaders = headerInfo.rawHeaders;
    const dataRows = parsed.rows.slice(headerInfo.headerIndex + 1);

    function colVal(cells, colIdx) {
      if (colIdx === null || colIdx === undefined || colIdx === '' || colIdx < 0) return 0;
      const idx = Number(colIdx);
      if (Number.isNaN(idx) || idx >= cells.length) return 0;
      return parseMoney(cells[idx]);
    }

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i].cells;
      if (isBlankRow(cells)) continue;
      res.rowsParsed += 1;
      res.ordersCount += 1;
      res.grossSales += colVal(cells, mapping.gross);
      res.platformFees += Math.abs(colVal(cells, mapping.fees));
      res.shippingLabels += Math.abs(colVal(cells, mapping.shipping));
      res.refunds += Math.abs(colVal(cells, mapping.refunds));
      res.netPayout += colVal(cells, mapping.net);
    }

    res.estimated1099KGross = res.grossSales;
    res.mismatchNote = 'Reconciled using your manual column mapping. Verify that Net Payout matches your bank transfers.';
    return finalizeResult(res);
  }

  function parseResellerCSV(text, filename) {
    const parsed = parseCSVText(text);
    const headerInfo = findHeaderRow(parsed.rows);
    if (!headerInfo) {
      return {
        needsManualMapping: true,
        filename: filename || 'upload.csv',
        rawHeaders: [],
        warnings: [{ row: 0, message: 'Empty or unreadable CSV file.' }]
      };
    }

    const dataRows = parsed.rows.slice(headerInfo.headerIndex + 1);
    if (headerInfo.platform === 'unknown') {
      return {
        needsManualMapping: true,
        filename: filename || 'upload.csv',
        rawHeaders: headerInfo.rawHeaders,
        warnings: parsed.warnings.concat([{
          row: headerInfo.lineNumber,
          message: 'Unrecognized CSV headers. Use the manual column mapper below to reconcile this file.'
        }])
      };
    }

    let result;
    if (headerInfo.platform === 'whatnot') {
      result = parseWhatnot(dataRows, headerInfo.normHeaders, filename, parsed.warnings);
    } else if (headerInfo.platform === 'poshmark') {
      result = parsePoshmark(dataRows, headerInfo.normHeaders, filename, parsed.warnings, headerInfo.lineNumber);
    } else if (headerInfo.platform === 'mercari') {
      result = parseMercari(dataRows, headerInfo.normHeaders, filename, parsed.warnings);
    } else if (headerInfo.platform === 'etsy_statement') {
      result = parseEtsyStatement(dataRows, headerInfo.normHeaders, filename, parsed.warnings);
    } else {
      result = parseEtsyBasic(headerInfo.platform, dataRows, headerInfo.normHeaders, filename, parsed.warnings);
    }
    result.rawHeaders = headerInfo.rawHeaders;
    return result;
  }

  function mergeResults(results) {
    const merged = emptyResult('combined', 'Combined Multi-Platform Summary', results.length + ' files');
    merged.files = results;
    const seenFilenames = new Set();

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (seenFilenames.has(r.filename)) {
        merged.warnings.push({
          row: 0,
          message: 'Duplicate filename detected: "' + r.filename + '". Remove one copy if you dropped the same period twice.'
        });
      }
      seenFilenames.add(r.filename);

      merged.rowsParsed += r.rowsParsed;
      merged.ordersCount += r.ordersCount;
      merged.canceledCount += r.canceledCount;
      merged.inProgressCount += r.inProgressCount;
      merged.giveawaysCount += r.giveawaysCount;
      merged.estimated1099KGross += r.estimated1099KGross;
      merged.grossSales += r.grossSales;
      merged.tips += r.tips;
      merged.platformFees += r.platformFees;
      merged.marketingFees += r.marketingFees;
      merged.shippingLabels += r.shippingLabels;
      merged.giveawayCosts += r.giveawayCosts;
      merged.refunds += r.refunds;
      merged.buyerSalesTaxExcluded += r.buyerSalesTaxExcluded;
      merged.cogsFromCsv += r.cogsFromCsv;
      merged.netPayout += r.netPayout;
      if (r.bankDepositsReported !== null) {
        merged.bankDepositsReported = (merged.bankDepositsReported || 0) + r.bankDepositsReported;
      }
      for (let w = 0; w < r.warnings.length; w++) {
        merged.warnings.push({
          row: r.warnings[w].row,
          message: '[' + r.filename + '] ' + r.warnings[w].message
        });
      }
    }

    merged.mismatchNote = 'Combined across ' + results.length + ' CSV file(s). Review per-platform cards below for platform-specific 1099-K rules.';
    return finalizeResult(merged);
  }

  function buildScheduleCCSV(summary, cogsData) {
    const cogs = cogsData || {};
    const cogsTotal = round2(Number(cogs.totalCogs || 0));
    const supplies = round2(Number(cogs.supplies || 0));
    const otherExp = round2(Number(cogs.otherExpenses || 0));

    const line1 = round2(summary.grossSales + summary.tips);
    const line2 = round2(summary.refunds);
    const line3 = round2(line1 - line2);
    const line4 = cogsTotal;
    const line5 = round2(line3 - line4);
    const line8 = round2(summary.marketingFees + summary.giveawayCosts);
    const line10 = round2(summary.platformFees);
    const line18 = round2(summary.shippingLabels);
    const line22 = supplies;
    const line27a = otherExp;
    const totalExpenses = round2(line8 + line10 + line18 + line22 + line27a);
    const netProfit = round2(line5 - totalExpenses);

    const lines = [
      ['Schedule C Line', 'Category', 'Amount (USD)', 'Notes'],
      ['Reference', 'Estimated 1099-K Gross Reported', summary.estimated1099KGross.toFixed(2), 'Before platform fees, shipping, refunds, and excluded buyer sales tax'],
      ['Reference', 'Buyer Sales Tax Excluded', summary.buyerSalesTaxExcluded.toFixed(2), 'Collected and remitted by marketplaces (not seller income)'],
      ['Line 1', 'Gross receipts or sales', line1.toFixed(2), 'Item sales + tips (excluding buyer sales tax)'],
      ['Line 2', 'Returns and allowances', line2.toFixed(2), 'Order refunds'],
      ['Line 3', 'Subtract line 2 from line 1', line3.toFixed(2), ''],
      ['Line 4', 'Cost of goods sold (COGS)', line4.toFixed(2), 'From local COGS worksheet / CSV'],
      ['Line 5', 'Gross profit', line5.toFixed(2), ''],
      ['Line 8', 'Advertising / Marketing / Giveaways', line8.toFixed(2), 'Etsy Ads, Offsite Ads, Whatnot giveaway labels'],
      ['Line 10', 'Commissions and fees', line10.toFixed(2), 'Platform commissions, processing fees, fee taxes'],
      ['Line 18 / 27a', 'Shipping labels & postage', line18.toFixed(2), 'Seller-paid shipping labels, discounts, upgrades, adjustments'],
      ['Line 22', 'Supplies', line22.toFixed(2), 'From local worksheet'],
      ['Line 27a', 'Other expenses', line27a.toFixed(2), 'From local worksheet'],
      ['Line 28', 'Total expenses', totalExpenses.toFixed(2), ''],
      ['Line 31', 'Estimated Net Profit (Loss)', netProfit.toFixed(2), 'For tax prep review with your CPA; not tax advice']
    ];

    return lines.map(function (r) {
      return r.map(function (cell) {
        const s = String(cell);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }).join(',');
    }).join('\r\n');
  }

  // Realistic 1-click sample CSVs matching verified schemas
  const SAMPLES = {
    whatnot: {
      filename: 'whatnot_weekly_orders_sample.csv',
      content: [
        'Transaction Completed At (UTC),Order Placed At (UTC),Order ID,Transaction Type,Livestream ID,Livestream Title,Buy Format,Post Coupon Price,Buyer Paid,Commission Fee,Payment Processing Fee,Shipping Fee,Transaction Amount,Cost of Goods,Shipment ID',
        '2026-11-22 18:10:00,2026-11-22 18:05:00,WN-9001,Order Earnings,LS-101,Black Friday Vintage Drop,Auction,$85.00,$98.40,$6.80,$3.15,$0.00,$75.05,$22.00,SH-1',
        '2026-11-22 18:14:00,2026-11-22 18:12:00,WN-9002,Order Earnings,LS-101,Black Friday Vintage Drop,Buy-it-Now,$40.00,$47.20,$3.20,$1.67,$4.25,$30.88,$10.00,SH-2',
        '2026-11-22 18:20:00,2026-11-22 18:19:00,WN-9003,Order Earnings,LS-101,Black Friday Vintage Drop,Giveaway,$0.00,$0.00,$0.00,$0.00,$4.47,-$4.47,$0.00,SH-3',
        '2026-11-23 10:00:00,,WN-8955,Order Refund,,,,$0.00,$0.00,$0.00,$0.00,$0.00,-$28.50,$0.00,',
        '2026-11-23 12:15:00,,WN-TIP1,Tips,LS-101,Black Friday Vintage Drop,,$0.00,$0.00,$0.00,$0.00,$0.00,$10.00,$0.00,',
        '2026-11-24 09:30:00,,,Shipping Charge,,,,$0.00,$0.00,$0.00,$0.00,$0.00,-$3.85,$0.00,SH-1'
      ].join('\n')
    },
    poshmark: {
      filename: 'poshmark_sales_activity_sample.csv',
      content: [
        '"Poshmark Sales Activity Report"',
        '"Date Range: 11/01/2026 - 11/26/2026"',
        '"Notes:"',
        '"** This report includes completed orders only."',
        '"** Sales tax is collected and remitted by Poshmark."',
        '"** Bundle discounts are prorated."',
        '"** Shipping discounts reflect seller-funded offers."',
        '"** Upgraded labels are deducted from earnings."',
        '"** Packaging fees apply to select orders."',
        '"** Consult your tax advisor for 1099-K reconciliation."',
        '"** Figures are in USD."',
        '""',
        'Listing Date,Order Date,SKU,Order Id,Listing Title,Department,Category,Subcategory,Brand,Color,Size,Bundle Order?,Offer Order,NWT,Cost Price,Order Price,Lowest Set Price,Seller Shipping Discount,Upgraded Shipping Label Fee,Packaging Fee,Your Earnings,Buyer State,Buyer Zip Code,Buyer Username,Sales Tax (Paid by Buyer),Notes,Other Info',
        '10/15/2026,11/18/2026,SKU-101,PM-4001,Vintage Wool Coat,Women,Jackets,Coats,Pendleton,Navy,M,No,Yes,No,$18.00,$70.00,$60.00,$2.02,$0.00,$0.00,$53.98,CA,90210,buyer1,$6.65,,',
        '10/20/2026,11/20/2026,SKU-102,PM-4002,Graphic Tee,Men,Shirts,Tees,Nike,Black,L,No,No,No,$3.50,$13.00,$12.00,$0.00,$0.00,$0.00,$10.05,NY,10001,buyer2,$1.15,,',
        '11/01/2026,11/24/2026,SKU-103,PM-4003,Leather Boots Heavy,Women,Shoes,Boots,Doc Martens,Black,8,No,No,Yes,$35.00,$120.00,$110.00,$0.00,$4.50,$0.00,$91.50,TX,78701,buyer3,$9.90,,'
      ].join('\n')
    },
    mercari: {
      filename: 'mercari_gross_sales_sample.csv',
      content: [
        '"Item ID","Sold Date","Canceled Date","Completed Date","Item Title","Order Status","Shipped to State","Shipped from State","Item Price","Buyer Shipping Fee","Seller Shipping Fee","Mercari Selling Fee","Payment Processing Fee","Shipping Adjustment Fee","Net Seller Proceeds","Sales Tax Charged to Buyer","Merchant Fees Charged to Buyer","Service Fee Charged to Buyer","Buyer Protection Charged to Buyer","Payment Processing Fee Charged to Buyer"',
        '"m1001","2026-11-18","","2026-11-21","Acme Blue Pillow Cover 20"" x 20" Linen","Completed","FL","OH","45.00","6.99","0.00","4.50","0.00","0.00","40.50","3.15","0.00","0.00","1.62","0.00"',
        '"m1002","2026-11-19","","2026-11-23","Nintendo GameCube Controller","Completed","TX","OH","38.00","0.00","6.99","3.80","0.00","2.15","25.06","3.14","0.00","0.00","1.37","0.00"',
        '"m1003","2026-11-22","2026-11-23","","Broken Camera Lot","Canceled","CA","OH","60.00","7.99","0.00","0.00","0.00","0.00","0.00","4.80","0.00","0.00","2.16","0.00"'
      ].join('\n')
    },
    etsy: {
      filename: 'etsy_statement_2026_11_sample.csv',
      content: [
        'Date,Type,Title,Info,Currency,Amount,Fees & Taxes,Net,Tax Details,Status,Availability Date',
        '"November 20, 2026",Sale,Payment for Order #30101,Order #30101,USD,$58.40,--,$58.40,--',
        '"November 20, 2026",Tax,Sales tax paid by buyer,Order #30101,USD,--,-$4.40,-$4.40,--',
        '"November 20, 2026",Fee,Transaction fee: Handmade Mug,Order #30101,USD,--,-$3.51,-$3.51,--',
        '"November 20, 2026",Fee,Processing fee,Order #30101,USD,--,-$2.00,-$2.00,--',
        '"November 20, 2026",Fee,Listing fee,Listing #991,USD,--,-$0.20,-$0.20,--',
        '"November 20, 2026",Fee,Listing fee,Listing #991,USD,--,-$0.20,-$0.20,--',
        '"November 21, 2026",Shipping,USPS Shipping Label,Label #551,USD,--,-$5.65,-$5.65,--',
        '"November 22, 2026",Marketing,Etsy Ads bill,Daily spend,USD,--,-$4.00,-$4.00,--',
        '"November 24, 2026",Deposit,"$38.44 sent to your bank account",Deposit,USD,--,--,--,--'
      ].join('\n')
    }
  };

  return {
    parseCSVText: parseCSVText,
    parseResellerCSV: parseResellerCSV,
    parseManual: parseManual,
    mergeResults: mergeResults,
    buildScheduleCCSV: buildScheduleCCSV,
    normalizeHeader: normalizeHeader,
    parseMoney: parseMoney,
    SAMPLES: SAMPLES
  };
});
