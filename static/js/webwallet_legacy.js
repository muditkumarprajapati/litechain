// WebWallet Modern Single Page Web Application Engine

let state = {
  currentUser: null,
  portfolio: null,
  market: null,
  supportedCoins: [],
  transactions: [],
  isBalanceHidden: false,
  activeTxFilter: 'ALL'
};

document.addEventListener('DOMContentLoaded', async () => {
  await loadMarketOverview();
  await checkAuth();
  setupPolling();
});

// Setup real-time polling
function setupPolling() {
  setInterval(async () => {
    await loadMarketOverview(true);
    if (state.currentUser) {
      await loadPortfolio(true);
      await loadTransactions(true);
    }
  }, 7000);
}

// Authentication Check
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.authenticated) {
      state.currentUser = data.user;
      renderNavbarUser();
      await loadPortfolio();
      await loadTransactions();
    } else {
      // Auto-authenticate with demo user for smooth instant preview
      await executeDemoLogin(false);
    }
  } catch (e) {
    console.error('Auth error:', e);
  }
}

// 1-Click Demo Login
async function executeDemoLogin(showNotification = true) {
  const username = document.getElementById('demoUsername')?.value || "SpideyDev";
  const discord_id = document.getElementById('demoUserId')?.value || "1523293430858383441";

  try {
    const res = await fetch('/api/auth/login-demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, discord_id })
    });
    const data = await res.json();
    if (data.success) {
      state.currentUser = data.user;
      renderNavbarUser();
      closeModal('loginModal');
      await loadPortfolio();
      await loadTransactions();
      if (showNotification) showToast(`Welcome back, ${data.user.username}! 🎉`);
    }
  } catch (e) {
    console.error('Demo login error:', e);
    showToast('Failed to log in', true);
  }
}

// User Logout
async function executeLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    state.currentUser = null;
    state.portfolio = null;
    renderNavbarUser();
    renderPortfolioEmpty();
    showToast('Logged out successfully.');
  } catch (e) {
    console.error('Logout error:', e);
  }
}

// Render User Nav Header
function renderNavbarUser() {
  const container = document.getElementById('navUserArea');
  if (!state.currentUser) {
    container.innerHTML = `
      <button class="btn-discord-login" onclick="openModal('loginModal')">
        <i class="fa-brands fa-discord"></i> Login with Discord
      </button>
    `;
    return;
  }

  const avatar = state.currentUser.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
  container.innerHTML = `
    <div class="user-profile-pill" onclick="confirmLogout()">
      <img src="${avatar}" alt="${state.currentUser.username}" class="user-avatar-img">
      <div style="display:flex; flex-direction:column; line-height:1.2;">
        <span class="user-name-txt">${state.currentUser.username}</span>
        <span style="font-size:0.7rem; color:var(--text-muted); font-family:var(--font-mono);">ID: ${state.currentUser.discord_id.slice(0, 7)}...</span>
      </div>
      <i class="fa-solid fa-arrow-right-from-bracket" style="font-size:0.8rem; color:var(--text-muted); margin-left:4px;" title="Logout"></i>
    </div>
  `;
}

function confirmLogout() {
  if (confirm(`Logged in as ${state.currentUser.username} (${state.currentUser.discord_id}). Do you want to log out?`)) {
    executeLogout();
  }
}

// Load Market Rates and Platform Metadata
async function loadMarketOverview(silent = false) {
  try {
    const res = await fetch('/api/market/overview');
    const data = await res.json();
    state.market = data.market;
    state.supportedCoins = data.supported_coins;

    renderMarketTicker();
    populateModalSelectors();
  } catch (e) {
    console.error('Failed to fetch market overview:', e);
  }
}

// Render Top Ticker Strip
function renderMarketTicker() {
  const ticker = document.getElementById('marketTicker');
  if (!ticker || !state.market || !state.supportedCoins.length) return;

  const { prices, changes_24h } = state.market;
  ticker.innerHTML = state.supportedCoins.map(coin => {
    const price = prices[coin.symbol] || 0;
    const chg = changes_24h[coin.symbol] || 0;
    const isUp = chg >= 0;
    return `
      <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:10px; padding:8px 16px; display:flex; align-items:center; gap:10px; white-space:nowrap; flex-shrink:0;">
        <span style="font-weight:800; font-size:0.9rem;">${coin.symbol}</span>
        <span style="font-family:var(--font-mono); font-weight:700; font-size:0.88rem;">$${formatNumber(price)}</span>
        <span style="font-size:0.75rem; font-weight:700; color:${isUp ? 'var(--accent-green)' : 'var(--accent-red)'};">
          ${isUp ? '+' : ''}${chg.toFixed(2)}%
        </span>
      </div>
    `;
  }).join('');
}

// Load Portfolio
async function loadPortfolio(silent = false) {
  if (!state.currentUser) return;
  try {
    const res = await fetch('/api/wallet/portfolio');
    if (res.status === 401) {
      state.currentUser = null;
      renderNavbarUser();
      return;
    }
    const data = await res.json();
    state.portfolio = data;
    renderPortfolioValuation();
    renderAssetsTable();
  } catch (e) {
    console.error('Portfolio load error:', e);
  }
}

// Render Portfolio Valuation Banner
function renderPortfolioValuation() {
  const valEl = document.getElementById('portfolioValuation');
  if (!valEl || !state.portfolio) return;

  if (state.isBalanceHidden) {
    valEl.innerHTML = `•••••• <span style="font-size:1.2rem; color:var(--text-muted); font-weight:500;">USD</span>`;
  } else {
    valEl.innerHTML = `$${formatNumber(state.portfolio.total_valuation_usd, 2)} <span style="font-size:1.2rem; color:var(--text-muted); font-weight:500;">USD</span>`;
  }
}

function renderPortfolioEmpty() {
  document.getElementById('portfolioValuation').innerHTML = `$0.00 <span style="font-size:1.2rem; color:var(--text-muted); font-weight:500;">USD</span>`;
  document.getElementById('assetsTableBody').innerHTML = `
    <tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">Please login with Discord to view your portfolio.</td></tr>
  `;
  document.getElementById('txHistoryBody').innerHTML = `
    <tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);">Login with Discord to view your transactions.</td></tr>
  `;
}

function toggleBalanceVisibility() {
  state.isBalanceHidden = !state.isBalanceHidden;
  const btn = document.getElementById('toggleBalanceBtn');
  if (state.isBalanceHidden) {
    btn.className = "fa-regular fa-eye-slash";
  } else {
    btn.className = "fa-regular fa-eye";
  }
  renderPortfolioValuation();
  renderAssetsTable();
}

// Render Assets Table
function renderAssetsTable() {
  const tbody = document.getElementById('assetsTableBody');
  if (!tbody || !state.portfolio) return;

  const filter = (document.getElementById('tokenSearchInput')?.value || '').toLowerCase().trim();
  const assets = state.portfolio.assets.filter(a => 
    a.coin.toLowerCase().includes(filter) || a.name.toLowerCase().includes(filter)
  );

  if (!assets.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">No assets match your search.</td></tr>`;
    return;
  }

  tbody.innerHTML = assets.map(asset => {
    const isUp = asset.change_24h >= 0;
    const balDisplay = state.isBalanceHidden ? '••••••' : formatNumber(asset.balance, 6);
    const usdDisplay = state.isBalanceHidden ? '••••••' : `$${formatNumber(asset.value_usd, 2)}`;

    return `
      <tr>
        <td>
          <div class="coin-cell">
            <div class="coin-icon-circle" style="background:${asset.color}20; color:${asset.color}; border:1px solid ${asset.color}40;">
              ${asset.icon}
            </div>
            <div class="coin-details">
              <span class="coin-sym">${asset.coin} <span style="font-weight:400; color:var(--text-secondary); font-size:0.85rem;">${asset.name}</span></span>
              <span class="coin-network">${asset.network}</span>
            </div>
          </div>
        </td>
        <td style="font-family:var(--font-mono); font-weight:700;">
          $${formatNumber(asset.price_usd)}
        </td>
        <td>
          <span style="font-weight:700; color:${isUp ? 'var(--accent-green)' : 'var(--accent-red)'}; font-size:0.88rem;">
            ${isUp ? '+' : ''}${asset.change_24h.toFixed(2)}%
          </span>
        </td>
        <td style="font-family:var(--font-mono); font-weight:700;">
          ${balDisplay} <span style="font-size:0.8rem; color:var(--text-muted); font-weight:500;">${asset.coin}</span>
        </td>
        <td style="font-family:var(--font-mono); font-weight:800; color:var(--accent-cyan);">
          ${usdDisplay}
        </td>
        <td>
          <div class="table-ops">
            <button class="table-btn" onclick="openDepositFor('${asset.coin}')"><i class="fa-solid fa-circle-down"></i> Deposit</button>
            <button class="table-btn" onclick="openWithdrawFor('${asset.coin}')"><i class="fa-solid fa-paper-plane"></i> Withdraw</button>
            <button class="table-btn" onclick="openTipFor('${asset.coin}')"><i class="fa-solid fa-bolt"></i> Tip</button>
            <button class="table-btn" onclick="openSwapFor('${asset.coin}')"><i class="fa-solid fa-arrows-rotate"></i> Swap</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterAssetsTable() {
  renderAssetsTable();
}

// Load and Render Transaction History
async function loadTransactions(silent = false) {
  if (!state.currentUser) return;
  try {
    const res = await fetch('/api/wallet/transactions');
    if (res.status === 401) return;
    state.transactions = await res.json();
    renderTransactionsTable();
  } catch (e) {
    console.error('Transactions load error:', e);
  }
}

function filterTransactions(type, btn) {
  state.activeTxFilter = type;
  const buttons = document.querySelectorAll('#txFilterTabs .table-btn');
  buttons.forEach(b => {
    b.classList.remove('active');
    b.style.background = '';
    b.style.color = '';
  });
  if (btn) {
    btn.classList.add('active');
    btn.style.background = '#1e293b';
    btn.style.color = 'var(--accent-cyan)';
  }
  renderTransactionsTable();
}

function renderTransactionsTable() {
  const tbody = document.getElementById('txHistoryBody');
  if (!tbody) return;

  let txs = state.transactions;
  if (state.activeTxFilter !== 'ALL') {
    txs = txs.filter(t => t.type.toUpperCase() === state.activeTxFilter);
  }

  if (!txs.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);">No transactions recorded under this category.</td></tr>`;
    return;
  }

  tbody.innerHTML = txs.map(tx => {
    let typeBadge = '';
    let amountColor = 'var(--text-primary)';
    let sign = '';

    switch (tx.type) {
      case 'DEPOSIT':
        typeBadge = `<span style="background:rgba(16,185,129,0.15); color:var(--accent-green); padding:3px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;"><i class="fa-solid fa-circle-down"></i> Deposit</span>`;
        amountColor = 'var(--accent-green)';
        sign = '+';
        break;
      case 'WITHDRAW':
        typeBadge = `<span style="background:rgba(239,68,68,0.15); color:var(--accent-red); padding:3px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;"><i class="fa-solid fa-paper-plane"></i> Withdrawal</span>`;
        amountColor = 'var(--accent-red)';
        sign = '-';
        break;
      case 'TIP_SENT':
        typeBadge = `<span style="background:rgba(88,101,242,0.15); color:var(--accent-blurple); padding:3px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;"><i class="fa-solid fa-bolt"></i> Tip Sent</span>`;
        amountColor = 'var(--accent-red)';
        sign = '-';
        break;
      case 'TIP_RECEIVED':
        typeBadge = `<span style="background:rgba(0,242,254,0.15); color:var(--accent-cyan); padding:3px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;"><i class="fa-solid fa-gift"></i> Tip Received</span>`;
        amountColor = 'var(--accent-green)';
        sign = '+';
        break;
      case 'SWAP':
        typeBadge = `<span style="background:rgba(245,158,11,0.15); color:var(--accent-gold); padding:3px 8px; border-radius:4px; font-weight:700; font-size:0.75rem;"><i class="fa-solid fa-arrows-rotate"></i> Swap</span>`;
        break;
    }

    const counterparty = tx.counterparty ? `<span style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-secondary);">${tx.counterparty}</span>` : '<span style="color:var(--text-muted);">-</span>';
    const dateFormatted = new Date(tx.created_at).toLocaleString();

    return `
      <tr>
        <td>${typeBadge}</td>
        <td style="font-weight:700;">${tx.coin}</td>
        <td style="font-family:var(--font-mono); font-weight:700; color:${amountColor};">${sign}${formatNumber(tx.amount, 6)} ${tx.coin}</td>
        <td style="font-family:var(--font-mono); font-size:0.85rem; color:var(--text-muted);">$${formatNumber(tx.amount_usd, 2)}</td>
        <td>${counterparty}</td>
        <td style="font-size:0.8rem; color:var(--text-muted);">${dateFormatted}</td>
        <td style="text-align:right;">
          <span style="color:var(--accent-green); font-size:0.8rem; font-weight:700;"><i class="fa-solid fa-check-circle"></i> ${tx.status}</span>
        </td>
      </tr>
    `;
  }).join('');
}

// Populate Modal Selectors
function populateModalSelectors() {
  if (!state.supportedCoins.length) return;

  const options = state.supportedCoins.map(c => 
    `<option value="${c.symbol}">${c.icon} ${c.symbol} - ${c.name}</option>`
  ).join('');

  const depSel = document.getElementById('depositCoinSelect');
  const withSel = document.getElementById('withdrawCoinSelect');
  const tipSel = document.getElementById('tipCoinSelect');
  const swapFrom = document.getElementById('swapFromCoin');
  const swapTo = document.getElementById('swapToCoin');

  if (depSel && !depSel.children.length) depSel.innerHTML = options;
  if (withSel && !withSel.children.length) withSel.innerHTML = options;
  if (tipSel && !tipSel.children.length) tipSel.innerHTML = options;
  if (swapFrom && !swapFrom.children.length) swapFrom.innerHTML = options;
  if (swapTo && !swapTo.children.length) {
    swapTo.innerHTML = options;
    if (swapTo.options.length > 1) swapTo.selectedIndex = 1;
  }
}

// Modal Quick Action Launchers
function openDepositFor(coin) {
  openModal('depositModal');
  const sel = document.getElementById('depositCoinSelect');
  if (sel) {
    sel.value = coin;
    updateDepositDetails();
  }
}

function openWithdrawFor(coin) {
  openModal('withdrawModal');
  const sel = document.getElementById('withdrawCoinSelect');
  if (sel) {
    sel.value = coin;
    updateWithdrawDetails();
  }
}

function openTipFor(coin) {
  openModal('tipModal');
  const sel = document.getElementById('tipCoinSelect');
  if (sel) {
    sel.value = coin;
    updateTipDetails();
  }
}

function openSwapFor(coin) {
  openModal('swapModal');
  const fromSel = document.getElementById('swapFromCoin');
  if (fromSel) {
    fromSel.value = coin;
    calculateSwapOutput();
  }
}

// Deposit Modal Logic
function updateDepositDetails() {
  const coin = document.getElementById('depositCoinSelect').value;
  const asset = state.portfolio?.assets.find(a => a.coin === coin);
  const addr = asset ? asset.deposit_address : "Generating...";

  document.getElementById('depositNetworkTag').innerText = `${coin} Network`;
  document.getElementById('depositCoinWarn').innerText = coin;
  document.getElementById('depositAddressText').innerText = addr;

  // Render QR Code using standard QR API
  const qrImg = document.getElementById('depositQrImg');
  if (qrImg && addr && addr !== "Generating...") {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(addr)}`;
  }
}

function copyDepositAddress() {
  const addr = document.getElementById('depositAddressText').innerText;
  if (addr && addr !== "Generating...") {
    navigator.clipboard.writeText(addr);
    showToast('Deposit address copied to clipboard! 📋');
  }
}

// Simulate Deposit (Instant Account Credit)
async function simulateDeposit() {
  const coin = document.getElementById('depositCoinSelect').value;
  const amount = parseFloat(document.getElementById('simulateAmount').value);

  if (!amount || amount <= 0) {
    showToast('Enter a valid deposit amount', true);
    return;
  }

  try {
    const res = await fetch('/api/wallet/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin, amount })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Deposit confirmed! +${data.amount} ${data.coin} credited ($${data.amount_usd}) 🎉`);
      closeModal('depositModal');
      await loadPortfolio();
      await loadTransactions();
    } else {
      showToast(data.error || 'Deposit failed', true);
    }
  } catch (e) {
    showToast('Network error during deposit', true);
  }
}

// Withdraw Modal Logic
function updateWithdrawDetails() {
  const coin = document.getElementById('withdrawCoinSelect').value;
  const asset = state.portfolio?.assets.find(a => a.coin === coin);
  const bal = asset ? asset.balance : 0.0;

  document.getElementById('withdrawAvailBal').innerText = formatNumber(bal, 6);
  document.getElementById('withdrawAvailCoin').innerText = coin;
  document.getElementById('withdrawFeeCoin').innerText = coin;
  document.getElementById('withdrawNetworkHint').innerText = `${asset?.network || 'Native'} Chain`;

  updateWithdrawSummary();
}

function setMaxWithdraw() {
  const coin = document.getElementById('withdrawCoinSelect').value;
  const asset = state.portfolio?.assets.find(a => a.coin === coin);
  if (asset) {
    document.getElementById('withdrawAmount').value = asset.balance;
    updateWithdrawSummary();
  }
}

function updateWithdrawSummary() {
  const coin = document.getElementById('withdrawCoinSelect').value;
  const amount = parseFloat(document.getElementById('withdrawAmount').value) || 0;
  const receiveEl = document.getElementById('withdrawReceiveAmount');
  
  const fee = coin === 'BTC' ? 0.0001 : (coin === 'ETH' ? 0.001 : 0.0005);
  const receive = Math.max(0, amount - fee);
  receiveEl.innerText = `${formatNumber(receive, 6)} ${coin}`;
}

async function executeWithdraw() {
  const coin = document.getElementById('withdrawCoinSelect').value;
  const destination = document.getElementById('withdrawDestAddress').value.trim();
  const amount = parseFloat(document.getElementById('withdrawAmount').value);

  if (!destination) {
    showToast('Destination address is required', true);
    return;
  }
  if (!amount || amount <= 0) {
    showToast('Enter a valid amount to withdraw', true);
    return;
  }

  try {
    const res = await fetch('/api/wallet/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin, amount, destination })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Withdrawal of ${amount} ${coin} initiated successfully! 🚀`);
      closeModal('withdrawModal');
      document.getElementById('withdrawDestAddress').value = '';
      document.getElementById('withdrawAmount').value = '';
      await loadPortfolio();
      await loadTransactions();
    } else {
      showToast(data.error || 'Withdrawal failed', true);
    }
  } catch (e) {
    showToast('Withdrawal request failed', true);
  }
}

// Tip / P2P Transfer Modal Logic
function updateTipDetails() {
  const coin = document.getElementById('tipCoinSelect').value;
  const asset = state.portfolio?.assets.find(a => a.coin === coin);
  const bal = asset ? asset.balance : 0.0;

  document.getElementById('tipAvailBal').innerText = formatNumber(bal, 6);
  document.getElementById('tipAvailCoin').innerText = coin;
}

function setMaxTip() {
  const coin = document.getElementById('tipCoinSelect').value;
  const asset = state.portfolio?.assets.find(a => a.coin === coin);
  if (asset) {
    document.getElementById('tipAmount').value = asset.balance;
  }
}

function updateTipSummary() {}

async function executeTip() {
  const receiver = document.getElementById('tipReceiverInput').value.trim();
  const coin = document.getElementById('tipCoinSelect').value;
  const amount = parseFloat(document.getElementById('tipAmount').value);
  const memo = document.getElementById('tipMemo').value.trim();

  if (!receiver) {
    showToast('Receiver Discord ID or Username is required', true);
    return;
  }
  if (!amount || amount <= 0) {
    showToast('Enter a valid tip amount', true);
    return;
  }

  try {
    const res = await fetch('/api/wallet/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiver, coin, amount, memo })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`⚡ Instant tip of ${amount} ${coin} sent to ${receiver}!`);
      closeModal('tipModal');
      document.getElementById('tipReceiverInput').value = '';
      document.getElementById('tipAmount').value = '';
      document.getElementById('tipMemo').value = '';
      await loadPortfolio();
      await loadTransactions();
    } else {
      showToast(data.error || 'Tip transfer failed', true);
    }
  } catch (e) {
    showToast('Tip transfer failed', true);
  }
}

// Swap Modal Logic
function calculateSwapOutput() {
  const fromCoin = document.getElementById('swapFromCoin').value;
  const toCoin = document.getElementById('swapToCoin').value;
  const fromAmount = parseFloat(document.getElementById('swapFromAmount').value) || 0;

  const assetFrom = state.portfolio?.assets.find(a => a.coin === fromCoin);
  document.getElementById('swapFromAvail').innerText = `${formatNumber(assetFrom?.balance || 0, 4)} ${fromCoin}`;

  if (!state.market) return;
  const pFrom = state.market.prices[fromCoin] || 1;
  const pTo = state.market.prices[toCoin] || 1;

  const rate = pFrom / pTo;
  document.getElementById('swapExchangeRate').innerText = `1 ${fromCoin} = ${formatNumber(rate, 6)} ${toCoin}`;

  const toAmount = (fromAmount * pFrom) / pTo;
  document.getElementById('swapToAmount').value = formatNumber(toAmount, 6);
}

function setMaxSwap() {
  const fromCoin = document.getElementById('swapFromCoin').value;
  const assetFrom = state.portfolio?.assets.find(a => a.coin === fromCoin);
  if (assetFrom) {
    document.getElementById('swapFromAmount').value = assetFrom.balance;
    calculateSwapOutput();
  }
}

function flipSwapCoins() {
  const fromSel = document.getElementById('swapFromCoin');
  const toSel = document.getElementById('swapToCoin');
  const temp = fromSel.value;
  fromSel.value = toSel.value;
  toSel.value = temp;
  calculateSwapOutput();
}

async function executeSwap() {
  const from_coin = document.getElementById('swapFromCoin').value;
  const to_coin = document.getElementById('swapToCoin').value;
  const from_amount = parseFloat(document.getElementById('swapFromAmount').value);

  if (from_coin === to_coin) {
    showToast('Cannot swap identical coins', true);
    return;
  }
  if (!from_amount || from_amount <= 0) {
    showToast('Enter a valid amount to swap', true);
    return;
  }

  try {
    const res = await fetch('/api/wallet/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_coin, to_coin, from_amount })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Swapped ${data.from_amount} ${data.from_coin} ➔ ${data.to_amount} ${data.to_coin} ($${data.usd_value})! ✨`);
      closeModal('swapModal');
      document.getElementById('swapFromAmount').value = '';
      await loadPortfolio();
      await loadTransactions();
    } else {
      showToast(data.error || 'Swap failed', true);
    }
  } catch (e) {
    showToast('Swap request failed', true);
  }
}

// Modal open/close helpers
function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('active');
    if (id === 'depositModal') updateDepositDetails();
    if (id === 'withdrawModal') updateWithdrawDetails();
    if (id === 'tipModal') updateTipDetails();
    if (id === 'swapModal') calculateSwapOutput();
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

function scrollToTransactions() {
  document.getElementById('txHistorySection')?.scrollIntoView({ behavior: 'smooth' });
}

function switchView(view) {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Toast System
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.innerText = message;
  toast.style.borderColor = isError ? 'var(--accent-red)' : 'var(--accent-cyan)';
  toast.style.color = isError ? '#fca5a5' : '#ffffff';
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3800);
}

// Utilities
function formatNumber(num, decimals = 2) {
  if (isNaN(num)) return '0.00';
  if (num >= 1000) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return parseFloat(num.toFixed(decimals)).toString();
}

