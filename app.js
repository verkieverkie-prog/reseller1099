(function () {
  'use strict';

  const PRO_CODE = 'R1099PRO26';
  const PRO_STORAGE_KEY = 'reseller1099_pro_unlocked';
  const COGS_STORAGE_KEY = 'reseller1099_cogs_v1';

  const P = window.ResellerParser;
  let isPro = false;
  let parsedFiles = [];
  let pendingManualFile = null; // { filename, text, rawHeaders }
  let heldExtraFilesCount = 0;

  // DOM helpers
  function $(id) { return document.getElementById(id); }

  function trackEvent(path, title) {
    try {
      if (window.goatcounter && typeof window.goatcounter.count === 'function') {
        window.goatcounter.count({
          path: path,
          title: title || path,
          event: true
        });
        return true;
      }
    } catch (e) {}
    return false;
  }

  function trackEventWhenReady(path, title) {
    if (trackEvent(path, title)) return;
    window.addEventListener('load', function () {
      if (!trackEvent(path, title)) {
        setTimeout(function () { trackEvent(path, title); }, 800);
      }
    }, { once: true });
  }

  function fmt(n) {
    const val = Number(n || 0);
    const abs = Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (val < 0 ? '-$' : '$') + abs;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function checkProStatus() {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = (params.get('pro') || '').trim().toUpperCase();
      if (code === PRO_CODE) {
        localStorage.setItem(PRO_STORAGE_KEY, '1');
        if (window.history && window.history.replaceState) {
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
        }
        trackEventWhenReady('event/pro-unlocked', 'Pro unlocked via redirect');
      }
      isPro = localStorage.getItem(PRO_STORAGE_KEY) === '1';
    } catch (e) {
      isPro = false;
    }
    updateProUI();
  }

  function updateProUI() {
    $('pro-badge').classList.toggle('hidden', !isPro);
    const topbarProBtn = $('topbar-pro-btn');
    if (topbarProBtn) {
      topbarProBtn.classList.toggle('hidden', isPro);
    }
    $('pro-upsell-card').classList.toggle('hidden', isPro);
    $('pro-unlocked-bar').classList.toggle('hidden', !isPro);
    $('pro-tools-card').classList.toggle('hidden', !isPro || parsedFiles.length === 0);
    const freeExportUpsell = $('free-export-upsell');
    if (freeExportUpsell) {
      freeExportUpsell.classList.toggle('hidden', isPro);
    }
    const allSamplesBtn = $('load-all-samples-btn');
    if (allSamplesBtn) {
      allSamplesBtn.classList.toggle('hidden', !isPro);
    }
  }

  function unlockWithCode(raw) {
    const code = String(raw || '').trim().toUpperCase();
    const msgEl = $('unlock-msg');
    if (code === PRO_CODE) {
      try { localStorage.setItem(PRO_STORAGE_KEY, '1'); } catch (e) {}
      isPro = true;
      heldExtraFilesCount = 0;
      msgEl.textContent = 'Pro unlocked on this browser.';
      msgEl.style.color = '#86efac';
      trackEvent('event/pro-unlocked', 'Pro unlocked via manual code');
      updateProUI();
      render();
    } else {
      msgEl.textContent = 'Invalid unlock code. Check your Stripe receipt.';
      msgEl.style.color = '#fca5a5';
    }
  }

  function loadCogsFromStorage() {
    try {
      const saved = JSON.parse(localStorage.getItem(COGS_STORAGE_KEY) || '{}');
      $('cogs-beg').value = saved.beg || '';
      $('cogs-purch').value = saved.purch || '';
      $('cogs-end').value = saved.end || '';
      $('cogs-direct').value = saved.direct || '';
      $('cogs-supplies').value = saved.supplies || '';
      $('cogs-other').value = saved.other || '';
    } catch (e) {}
  }

  function getCogsData() {
    const beg = P.parseMoney($('cogs-beg').value);
    const purch = P.parseMoney($('cogs-purch').value);
    const end = P.parseMoney($('cogs-end').value);
    const direct = P.parseMoney($('cogs-direct').value);
    const supplies = P.parseMoney($('cogs-supplies').value);
    const otherExpenses = P.parseMoney($('cogs-other').value);

    const calcCogs = (beg !== 0 || purch !== 0 || end !== 0)
      ? Math.max(0, beg + purch - end)
      : direct;

    return {
      beg: beg,
      purch: purch,
      end: end,
      direct: direct,
      totalCogs: Math.round((calcCogs + Number.EPSILON) * 100) / 100,
      supplies: supplies,
      otherExpenses: otherExpenses
    };
  }

  function saveCogsAndRefresh() {
    const payload = {
      beg: $('cogs-beg').value,
      purch: $('cogs-purch').value,
      end: $('cogs-end').value,
      direct: $('cogs-direct').value,
      supplies: $('cogs-supplies').value,
      other: $('cogs-other').value
    };
    try { localStorage.setItem(COGS_STORAGE_KEY, JSON.stringify(payload)); } catch (e) {}
    renderCogsSummary();
  }

  function getCurrentSummary() {
    if (parsedFiles.length === 0) return null;
    if (parsedFiles.length === 1) return parsedFiles[0];
    return P.mergeResults(parsedFiles);
  }

  function renderCogsSummary() {
    const summary = getCurrentSummary();
    if (!summary) return;
    const cogs = getCogsData();
    const line1 = summary.grossSales + summary.tips;
    const line5 = line1 - summary.refunds - cogs.totalCogs;
    const totalExp = summary.platformFees + summary.marketingFees + summary.shippingLabels + summary.giveawayCosts + cogs.supplies + cogs.otherExpenses;
    const netProfit = line5 - totalExp;
    $('cogs-calc-display').innerHTML =
      'Calculated COGS (Line 4): <strong>' + fmt(cogs.totalCogs) + '</strong> | ' +
      'Estimated Schedule C Net Profit (Line 31): <strong>' + fmt(netProfit) + '</strong>';
  }

  function showManualMapper(fileObj) {
    pendingManualFile = fileObj;
    const card = $('manual-mapper-card');
    card.classList.remove('hidden');
    $('manual-filename').textContent = fileObj.filename;

    const selects = ['map-gross', 'map-fees', 'map-shipping', 'map-refunds', 'map-net'];
    selects.forEach(function (id) {
      const sel = $(id);
      sel.innerHTML = '<option value="-1">-- None / Skip --</option>';
      fileObj.rawHeaders.forEach(function (h, idx) {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = (idx + 1) + ': ' + (h || '(blank)');
        sel.appendChild(opt);
      });
    });
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function handleCSVInputs(items, isSample) {
    if (!items || items.length === 0) return;
    $('manual-mapper-card').classList.add('hidden');
    pendingManualFile = null;
    heldExtraFilesCount = 0;

    const parsedPlatforms = [];

    if (!isPro) {
      if (items.length > 1) {
        heldExtraFilesCount = items.length - 1;
      }
      const first = items[0];
      const res = P.parseResellerCSV(first.text, first.filename);
      if (res.needsManualMapping) {
        parsedFiles = [];
        showManualMapper({ filename: first.filename, text: first.text, rawHeaders: res.rawHeaders });
      } else {
        parsedFiles = [res];
        if (res.platform) parsedPlatforms.push(res.platform);
      }
    } else {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const res = P.parseResellerCSV(item.text, item.filename);
        if (res.needsManualMapping) {
          showManualMapper({ filename: item.filename, text: item.text, rawHeaders: res.rawHeaders });
        } else {
          parsedFiles.push(res);
          if (res.platform && parsedPlatforms.indexOf(res.platform) === -1) {
            parsedPlatforms.push(res.platform);
          }
        }
      }
    }

    if (!isSample && parsedPlatforms.length > 0) {
      trackEvent('event/csv-parsed', 'CSV parsed: ' + parsedPlatforms.join(','));
    }

    render();
  }

  function readFilesFromList(fileList) {
    const files = Array.from(fileList || []).filter(function (f) {
      return f.name.toLowerCase().endsWith('.csv') || f.type === 'text/csv' || f.type === 'text/plain';
    });
    if (files.length === 0) {
      alert('Please drop one or more .csv files exported from Whatnot, Poshmark, Mercari, or Etsy.');
      return;
    }
    const readers = files.map(function (file) {
      return new Promise(function (resolve) {
        const r = new FileReader();
        r.onload = function () { resolve({ filename: file.name, text: String(r.result || '') }); };
        r.onerror = function () { resolve({ filename: file.name, text: '' }); };
        r.readAsText(file);
      });
    });
    Promise.all(readers).then(function (items) {
      handleCSVInputs(items, false);
    });
  }

  function render() {
    updateProUI();
    const resultsCard = $('results-card');
    if (parsedFiles.length === 0) {
      resultsCard.classList.add('hidden');
      return;
    }
    resultsCard.classList.remove('hidden');

    const summary = getCurrentSummary();

    // Multi-file notice if free user dropped >1 file
    const multiNotice = $('free-multi-notice');
    if (!isPro && heldExtraFilesCount > 0) {
      multiNotice.classList.remove('hidden');
      multiNotice.innerHTML =
        '<strong>Showing your first CSV below.</strong> You dropped ' + (heldExtraFilesCount + 1) +
        ' files. <a href="https://buy.stripe.com/3cIcN5exMgYO6U96sDgA80i" target="_blank" rel="noopener">Unlock Pro ($24 one-time)</a> to merge all ' +
        (heldExtraFilesCount + 1) + ' files into one full-year report + Schedule C CSV/PDF export.';
    } else {
      multiNotice.classList.add('hidden');
    }

    // Loaded file chips
    const chips = $('loaded-files-bar');
    chips.innerHTML = parsedFiles.map(function (f, idx) {
      return '<span class="file-chip">' +
        escapeHtml(f.filename) + ' (' + escapeHtml(f.platformLabel.split(' ')[0]) + ')' +
        ' <button type="button" data-remove-idx="' + idx + '" title="Remove file">x</button></span>';
    }).join('') +
      (parsedFiles.length > 0 ? '<button type="button" id="clear-all-btn" class="btn btn-secondary btn-sm">Clear all</button>' : '');

    chips.querySelectorAll('button[data-remove-idx]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const idx = Number(btn.getAttribute('data-remove-idx'));
        parsedFiles.splice(idx, 1);
        render();
      });
    });
    const clearBtn = $('clear-all-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        parsedFiles = [];
        heldExtraFilesCount = 0;
        render();
      });
    }

    // Header summary
    $('result-title').textContent = summary.platformLabel + ' (' + summary.ordersCount + ' completed orders)';

    // Top 4 KPI cards
    const totalFeesAndShip = summary.platformFees + summary.marketingFees + summary.shippingLabels + summary.giveawayCosts;
    $('kpi-grid').innerHTML = [
      {
        cls: 'stat-box',
        label: 'Est. 1099-K Gross',
        val: fmt(summary.estimated1099KGross),
        sub: 'Before fees, labels, refunds'
      },
      {
        cls: 'stat-box warn',
        label: 'Fees + Labels + Promo',
        val: fmt(totalFeesAndShip),
        sub: summary.effectiveTakeRatePct + '% of gross sales'
      },
      {
        cls: 'stat-box highlight',
        label: 'Net Payout to Bank',
        val: fmt(summary.netPayout),
        sub: summary.canceledCount > 0 ? summary.canceledCount + ' canceled/refunded' : 'Completed net earnings'
      },
      {
        cls: 'stat-box',
        label: '1099-K vs Bank Gap',
        val: fmt(summary.mismatchGap),
        sub: 'Explained line-by-line below'
      }
    ].map(function (k) {
      return '<div class="' + k.cls + '">' +
        '<div class="stat-label">' + k.label + '</div>' +
        '<div class="stat-val">' + k.val + '</div>' +
        '<div class="stat-sub">' + k.sub + '</div>' +
        '</div>';
    }).join('');

    // Waterfall rows
    const wf = [
      { cls: 'wf-row wf-total', label: 'Estimated 1099-K Gross Reported', amt: fmt(summary.estimated1099KGross) }
    ];
    if (summary.buyerSalesTaxExcluded > 0) {
      wf.push({ cls: 'wf-row wf-muted', label: 'Less: Buyer Sales Tax (remitted by marketplace, not your income)', amt: '-' + fmt(summary.buyerSalesTaxExcluded) });
    }
    wf.push({ cls: 'wf-row', label: 'Seller Gross Item Sales' + (summary.tips > 0 ? ' + Tips (' + fmt(summary.tips) + ')' : ''), amt: fmt(summary.grossSales + summary.tips) });
    if (summary.platformFees > 0) {
      wf.push({ cls: 'wf-row wf-neg', label: 'Less: Platform Commissions, Processing Fees & Fee Taxes (Schedule C Line 10)', amt: '-' + fmt(summary.platformFees) });
    }
    if (summary.shippingLabels > 0) {
      wf.push({ cls: 'wf-row wf-neg', label: 'Less: Seller Shipping Labels, Discounts & Adjustments (Schedule C Line 18/27a)', amt: '-' + fmt(summary.shippingLabels) });
    }
    if (summary.giveawayCosts > 0) {
      wf.push({ cls: 'wf-row wf-neg', label: 'Less: Giveaway Shipping Labels (' + summary.giveawaysCount + ' giveaways, Schedule C Line 8)', amt: '-' + fmt(summary.giveawayCosts) });
    }
    if (summary.marketingFees > 0) {
      wf.push({ cls: 'wf-row wf-neg', label: 'Less: Platform Marketing / Ads (Schedule C Line 8)', amt: '-' + fmt(summary.marketingFees) });
    }
    if (summary.refunds > 0) {
      wf.push({ cls: 'wf-row wf-neg', label: 'Less: Order Refunds (Schedule C Line 2)', amt: '-' + fmt(summary.refunds) });
    }
    wf.push({ cls: 'wf-row wf-total wf-pos', label: 'Net Payout (What Actually Hits Your Balance)', amt: fmt(summary.netPayout) });
    if (summary.bankDepositsReported !== null) {
      wf.push({ cls: 'wf-row wf-muted', label: 'Bank Deposits Noted in Statement Titles (Reconciliation Check, Excluded from Sums)', amt: fmt(summary.bankDepositsReported) });
    }
    if (summary.cogsFromCsv > 0) {
      wf.push({ cls: 'wf-row wf-muted', label: 'COGS Values Found Inside CSV (Reference)', amt: fmt(summary.cogsFromCsv) });
    }

    $('waterfall-box').innerHTML = wf.map(function (r) {
      return '<div class="' + r.cls + '"><span>' + escapeHtml(r.label) + '</span><span class="wf-amt">' + escapeHtml(r.amt) + '</span></div>';
    }).join('');

    $('mismatch-note').textContent = summary.mismatchNote;

    // Warnings panel
    const warnBox = $('warnings-box');
    if (summary.warnings && summary.warnings.length > 0) {
      warnBox.classList.remove('hidden');
      warnBox.innerHTML = '<h4>Parser Notes & Data Hygiene (' + summary.warnings.length + ')</h4><ul>' +
        summary.warnings.slice(0, 15).map(function (w) {
          const prefix = w.row ? 'Row ' + w.row + ': ' : '';
          return '<li>' + escapeHtml(prefix + w.message) + '</li>';
        }).join('') + '</ul>';
    } else {
      warnBox.classList.add('hidden');
    }

    if (isPro) {
      if (summary.cogsFromCsv > 0 && !$('cogs-direct').value && !$('cogs-beg').value && !$('cogs-purch').value) {
        $('cogs-direct').value = summary.cogsFromCsv.toFixed(2);
      }
      renderCogsSummary();
    }
  }

  function downloadScheduleCCSV() {
    const summary = getCurrentSummary();
    if (!summary) return;
    const csvText = P.buildScheduleCCSV(summary, getCogsData());
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'reseller1099_schedule_c_summary.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function init() {
    checkProStatus();
    loadCogsFromStorage();

    // Track clicks on any Stripe Payment Link CTA (topbar, locked results CTAs, upsell card, multi-file notice)
    document.addEventListener('click', function (e) {
      const link = e.target && e.target.closest ? e.target.closest('a[href^="https://buy.stripe.com/"]') : null;
      if (link) {
        trackEvent('event/stripe-checkout-clicked', 'Stripe checkout clicked');
      }
    });

    const dz = $('dropzone');
    const fileInput = $('file-input');

    dz.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function (e) {
      readFilesFromList(e.target.files);
      fileInput.value = '';
    });

    dz.addEventListener('dragover', function (e) {
      e.preventDefault();
      dz.classList.add('dragover');
    });
    dz.addEventListener('dragleave', function () {
      dz.classList.remove('dragover');
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.classList.remove('dragover');
      readFilesFromList(e.dataTransfer.files);
    });

    // 1-click sample buttons
    document.querySelectorAll('[data-sample]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.getAttribute('data-sample');
        const sample = P.SAMPLES[key];
        if (!sample) return;
        trackEvent('event/sample-clicked', 'Sample clicked: ' + key);
        handleCSVInputs([{ filename: sample.filename, text: sample.content }], true);
      });
    });

    $('load-all-samples-btn').addEventListener('click', function () {
      if (!isPro) return;
      const all = ['whatnot', 'poshmark', 'mercari', 'etsy'].map(function (k) {
        return { filename: P.SAMPLES[k].filename, text: P.SAMPLES[k].content };
      });
      trackEvent('event/sample-clicked', 'Sample clicked: all-4');
      parsedFiles = [];
      handleCSVInputs(all, true);
    });

    // Manual unlock code
    $('unlock-btn').addEventListener('click', function () {
      unlockWithCode($('unlock-code-input').value);
    });
    $('unlock-code-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        unlockWithCode($('unlock-code-input').value);
      }
    });

    // Manual column mapper submit
    $('apply-manual-map-btn').addEventListener('click', function () {
      if (!pendingManualFile) return;
      const mapping = {
        gross: $('map-gross').value,
        fees: $('map-fees').value,
        shipping: $('map-shipping').value,
        refunds: $('map-refunds').value,
        net: $('map-net').value
      };
      const res = P.parseManual(pendingManualFile.text, pendingManualFile.filename, mapping);
      if (isPro) {
        parsedFiles.push(res);
      } else {
        parsedFiles = [res];
      }
      trackEvent('event/csv-parsed', 'CSV parsed: manual');
      pendingManualFile = null;
      $('manual-mapper-card').classList.add('hidden');
      render();
    });

    // Pro COGS worksheet listeners
    ['cogs-beg', 'cogs-purch', 'cogs-end', 'cogs-direct', 'cogs-supplies', 'cogs-other'].forEach(function (id) {
      $(id).addEventListener('input', saveCogsAndRefresh);
    });

    $('export-csv-btn').addEventListener('click', downloadScheduleCCSV);
    $('print-pdf-btn').addEventListener('click', function () { window.print(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
