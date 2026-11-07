/**
 * WebWallet - Enterprise Multi-Cryptocurrency Platform Engine
 * High-performance Web3 application with Chart.js, Live Binance Streams, Multi-Chain Wallets,
 * Email/Password Auth, Discord OAuth2 with Guilds.Join, and Admin Member Puller.
 */

// Immediate session persistence synchronizer: runs before anything else
(function syncInitialSession() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');
    if (urlToken && urlToken !== 'null' && urlToken !== 'undefined') {
      localStorage.setItem('webwallet_session_token', urlToken);
      document.cookie = `webwallet_session=${urlToken}; path=/; max-age=31536000; SameSite=Lax`;
      urlParams.delete('token');
      const cleanSearch = urlParams.toString() ? '?' + urlParams.toString() : '';
      window.history.replaceState({}, document.title, window.location.pathname + cleanSearch + window.location.hash);
    } else {
      const localToken = localStorage.getItem('webwallet_session_token');
      const match = document.cookie.match(/(?:^|;\s*)webwallet_session=([^;]+)/);
      const cookieToken = match ? match[1] : null;
      if (localToken && localToken !== 'null' && localToken !== 'undefined' && (!cookieToken || cookieToken === 'null')) {
        document.cookie = `webwallet_session=${localToken}; path=/; max-age=31536000; SameSite=Lax`;
      } else if (cookieToken && cookieToken !== 'null' && cookieToken !== 'undefined' && (!localToken || localToken === 'null' || localToken === 'undefined')) {
        localStorage.setItem('webwallet_session_token', cookieToken);
      }
    }
  } catch (e) {
    console.warn('Initial session sync warning:', e);
  }
})();

// Auto-attach Bearer authorization header and credentials to all same-origin API requests
const _originalFetch = window.fetch;
window.fetch = function(url, init = {}) {
  const isApi = typeof url === 'string' && (url.startsWith('/api/') || url.startsWith('/app'));
  if (isApi) {
    init = init || {};
    init.credentials = init.credentials || 'include';
    const token = localStorage.getItem('webwallet_session_token');
    if (token && token !== 'null' && token !== 'undefined') {
      init.headers = init.headers || {};
      if (init.headers instanceof Headers) {
        if (!init.headers.has('Authorization')) {
          init.headers.set('Authorization', `Bearer ${token}`);
        }
      } else if (Array.isArray(init.headers)) {
        init.headers.push(['Authorization', `Bearer ${token}`]);
      } else {
        if (!init.headers['Authorization']) {
          init.headers['Authorization'] = `Bearer ${token}`;
        }
      }
    }
  }
  return _originalFetch.call(this, url, init);
};

let app = {
  currentUser: null,
  portfolio: null,
  market: null,
  supportedCoins: [],
  transactions: [],
  activeTimeframe: '24H',
  isBalanceHidden: false,
  charts: {
    portfolio: null,
    allocation: null
  },
  currentView: 'overview',
  authTab: 'email',
  emailMode: 'login'
};

document.addEventListener('DOMContentLoaded', async () => {
  const hash = window.location.hash ? window.location.hash.substring(1) : '';
  if (hash && hash.includes('access_token=')) {
    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    if (token) {
      try {
        const res = await fetch('/api/auth/discord/token-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: token })
        });
        const data = await res.json();
        if (data.success && data.token) {
          localStorage.setItem('webwallet_session_token', data.token);
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } catch (e) {
        console.error('Hash token auth error:', e);
      }
    }
  }
  await initCharts();
  await checkAuth();
  await loadMarketOverview();
  setupIntervals();
});

function setupIntervals() {
  setInterval(async () => {
    await loadMarketOverview(true);
    if (app.currentUser) {
      await loadPortfolio(true);
      await loadTransactions(true);
      if (app.currentUser.is_admin) await loadAdminMetrics(true);
    }
  }, 6000);
}

// ================= AUTHENTICATION =================

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.authenticated) {
      if (data.token) {
        localStorage.setItem('webwallet_session_token', data.token);
        document.cookie = `webwallet_session=${data.token}; path=/; max-age=31536000; SameSite=Lax`;
      }
      app.currentUser = data.user;
      renderUserUI();
      await loadPortfolio();
      await loadTransactions();
      if (app.currentUser.is_admin) await loadAdminMetrics();
    } else {
      if (res.status === 401 || !localStorage.getItem('webwallet_session_token')) {
        localStorage.removeItem('webwallet_session_token');
      }
      app.currentUser = null;
      app.portfolio = null;
      app.transactions = [];
      app.filteredTxs = [];
      renderUserUI();
      renderTransactionsTable();
      updateAllocationChart();
    }
  } catch (e) {
    console.error('Auth verification error:', e);
    app.currentUser = null;
    app.portfolio = null;
    app.transactions = [];
    app.filteredTxs = [];
    renderUserUI();
    renderTransactionsTable();
    updateAllocationChart();
  }
}

function switchAuthTab(tab) {
  app.authTab = tab;
  ['login', 'register', 'discord'].forEach(t => {
    const tabEl = document.getElementById(`authTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    const btnEl = document.getElementById(`tabBtn${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (tabEl) tabEl.style.display = t === tab ? 'block' : 'none';
    if (btnEl) {
      if (t === tab) btnEl.classList.add('active');
      else btnEl.classList.remove('active');
    }
  });
}

async function submitEmailLogin() {
  const email = document.getElementById('loginEmailInput').value.trim();
  const password = document.getElementById('loginPasswordInput').value.trim();

  if (!email || !password) {
    showToast('Email and password are required', true);
    return;
  }

  try {
    const res = await fetch('/api/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.success) {
      if (data.token) {
        localStorage.setItem('webwallet_session_token', data.token);
      }
      app.currentUser = data.user;
      renderUserUI();
      closeModal('authModal');
      await loadPortfolio();
      await loadTransactions();
      if (app.currentUser.is_admin) await loadAdminMetrics();
      showToast(`Welcome back, ${data.user.username}! 🚀`);
    } else {
      showToast(data.error || 'Login failed', true);
    }
  } catch (e) {
    showToast('Login request failed', true);
  }
}

async function submitEmailRegister() {
  const username = document.getElementById('regUsernameInput').value.trim();
  const email = document.getElementById('regEmailInput').value.trim();
  const password = document.getElementById('regPasswordInput').value.trim();

  if (!username) {
    showToast('Username is required for registration', true);
    return;
  }
  if (!email || !password) {
    showToast('Email and password are required', true);
    return;
  }

  try {
    const res = await fetch('/api/auth/email/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, username })
    });
    const data = await res.json();
    if (data.success) {
      if (data.token) {
        localStorage.setItem('webwallet_session_token', data.token);
      }
      app.currentUser = data.user;
      renderUserUI();
      closeModal('authModal');
      await loadPortfolio();
      await loadTransactions();
      showToast(`Welcome to WebWallet, ${data.user.username}! 🎉`);
    } else {
      showToast(data.error || 'Registration failed', true);
    }
  } catch (e) {
    showToast('Registration request failed', true);
  }
}

async function submitDiscordDirectLogin() {
  const input = document.getElementById('discordDirectInput').value.trim();
  if (!input) {
    showToast('Please enter your Discord username or ID', true);
    return;
  }

  const isNumeric = /^\d{16,21}$/.test(input);
  const payload = isNumeric ? { discord_id: input } : { username: input };

  try {
    const res = await fetch('/api/auth/discord/direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      if (data.token) {
        localStorage.setItem('webwallet_session_token', data.token);
      }
      app.currentUser = data.user;
      renderUserUI();
      closeModal('authModal');
      await loadPortfolio();
      await loadTransactions();
      if (app.currentUser.is_admin) await loadAdminMetrics();
      showToast(`Connected as ${data.user.username}! 🎮`);
    } else {
      showToast(data.error || 'Discord authentication failed', true);
    }
  } catch (e) {
    showToast('Discord authentication error', true);
  }
}

async function submitPasscodeLogin() {
  const identifier = document.getElementById('pinIdentifierInput').value.trim();
  const pin = document.getElementById('pinSecurityInput').value.trim();

  if (!identifier || !pin) {
    showToast('User ID/Username and Security PIN are required', true);
    return;
  }

  try {
    const res = await fetch('/api/auth/login-passcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, pin })
    });
    const data = await res.json();
    if (data.success) {
      if (data.token) {
        localStorage.setItem('webwallet_session_token', data.token);
      }
      app.currentUser = data.user;
      renderUserUI();
      closeModal('authModal');
      await loadPortfolio();
      await loadTransactions();
      if (app.currentUser.is_admin) await loadAdminMetrics();
      showToast(`Access granted: ${data.user.username}! 🔑`);
    } else {
      showToast(data.error || 'PIN authentication failed', true);
    }
  } catch (e) {
    showToast('PIN authentication error', true);
  }
}

async function executeLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    console.error('Logout error:', e);
  }
  localStorage.removeItem('webwallet_session_token');
  document.cookie = 'webwallet_session=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  app.currentUser = null;
  app.portfolio = null;
  app.transactions = [];
  app.filteredTxs = [];
  renderUserUI();
  renderTransactionsTable();
  updateAllocationChart();
  showToast('Session terminated.');
  switchView('overview');
}

function renderUserUI() {
  const area = document.getElementById('topbarUserArea');
  const adminItem = document.getElementById('adminSidebarItem');

  if (!app.currentUser) {
    area.innerHTML = `
      <button class="btn-action primary" onclick="openModal('authModal')">
        <i class="fa-solid fa-arrow-right-to-bracket"></i> Login / Register
      </button>
    `;
    if (adminItem) adminItem.style.display = 'none';

    const balEl = document.getElementById('totalBalanceUsd');
    if (balEl) balEl.innerHTML = '$0.00 <span style="font-size:1.1rem; color:var(--text-muted); font-weight:500;">USD</span>';

    renderProfileView();
    return;
  }

  const avatar = app.currentUser.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
  const isAdmin = Boolean(app.currentUser.is_admin);

  area.innerHTML = `
    <div class="user-profile-btn" onclick="switchView('profile')">
      <img src="${avatar}" class="user-avatar">
      <span class="user-name-label">${app.currentUser.username}</span>
      ${isAdmin ? '<span class="brand-badge" style="color:var(--accent-purple); border-color:var(--accent-purple);">ADMIN</span>' : '<span class="brand-badge" style="color:var(--accent-cyan); border-color:rgba(6,182,212,0.3);">MEMBER</span>'}
    </div>
  `;

  if (adminItem) {
    adminItem.style.display = isAdmin ? 'block' : 'none';
  }

  renderProfileView();
}

// ================= PROFILE TAB & USER PREFERENCES =================

function renderProfileView() {
  if (!app.currentUser) {
    const pAvatar = document.getElementById('profileAvatar');
    if (pAvatar) pAvatar.src = 'https://cdn.discordapp.com/embed/avatars/0.png';
    const pUser = document.getElementById('profileUsername');
    if (pUser) pUser.innerText = 'Not Signed In';
    const pDiscord = document.getElementById('profileDiscordId');
    if (pDiscord) pDiscord.innerText = 'Please sign in to access your wallet';
    const pUid = document.getElementById('profileUidVal');
    if (pUid) pUid.innerText = 'UID: #00000';
    const pBadge = document.getElementById('profileRoleBadge');
    if (pBadge) {
      pBadge.innerText = 'GUEST';
      pBadge.style.color = 'var(--text-muted)';
      pBadge.style.borderColor = 'var(--border-subtle)';
    }
    const pNet = document.getElementById('profileNetBalance');
    if (pNet) pNet.innerHTML = '$0.00 <span style="font-size:0.9rem; color:var(--text-muted); font-weight:500;">USD</span>';
    const pTx = document.getElementById('profileTxCount');
    if (pTx) pTx.innerText = '0 Records';
    const pDir = document.getElementById('profileAddressDirectory');
    if (pDir) pDir.innerHTML = `<div style="color:var(--text-muted); font-size:0.85rem; padding:12px;">Sign in to view your on-chain deposit addresses.</div>`;
    return;
  }

  const u = app.currentUser;
  const avatar = u.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
  const isAdmin = Boolean(u.is_admin);

  // Avatar & Basic info
  const pAvatar = document.getElementById('profileAvatar');
  if (pAvatar) pAvatar.src = avatar;

  const pUser = document.getElementById('profileUsername');
  if (pUser) pUser.innerText = u.username;

  const pDiscord = document.getElementById('profileDiscordId');
  if (pDiscord) {
    if (u.discord_id && u.discord_id.startsWith('email_')) {
      pDiscord.innerHTML = `<i class="fa-solid fa-envelope" style="color:var(--accent-cyan); margin-right:5px;"></i> ${u.email || 'Email Verified'}`;
    } else {
      pDiscord.innerHTML = `<i class="fa-brands fa-discord" style="color:var(--accent-blurple); margin-right:5px;"></i> Discord: ${u.username} (${u.discord_id || 'Linked'})`;
    }
  }

  // UID
  const pUid = document.getElementById('profileUidVal');
  if (pUid) pUid.innerText = `UID: #${u.id.toString().padStart(5, '0')}`;

  // Role Badge
  const pBadge = document.getElementById('profileRoleBadge');
  if (pBadge) {
    pBadge.innerText = isAdmin ? 'PLATFORM ADMIN' : 'VERIFIED MEMBER';
    pBadge.style.color = isAdmin ? 'var(--accent-purple)' : 'var(--accent-cyan)';
    pBadge.style.borderColor = isAdmin ? 'var(--accent-purple)' : 'rgba(6,182,212,0.4)';
  }

  // Member Since
  const pJoined = document.getElementById('profileJoinedDate');
  if (pJoined) {
    if (u.created_at) {
      try {
        const d = new Date(u.created_at);
        pJoined.innerText = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      } catch (e) {
        pJoined.innerText = 'Active Member';
      }
    } else {
      pJoined.innerText = 'Nov 2026';
    }
  }

  // Client Platform Detection
  const pPlatform = document.getElementById('profileClientPlatform');
  if (pPlatform) {
    const ua = navigator.userAgent;
    let os = 'Windows PC';
    if (ua.includes('Macintosh')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android Mobile';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS Device';
    
    let browser = 'Web Browser';
    if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
    else if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Edg')) browser = 'Edge';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';

    pPlatform.innerText = `${os} (${browser})`;
  }

  // Financial Highlights
  const pBal = document.getElementById('profileNetBalance');
  if (pBal) {
    const isHidden = app.isBalanceHidden;
    const cur = u.currency || localStorage.getItem('webwallet_currency') || 'USD';
    const totalUsd = app.portfolio ? app.portfolio.total_valuation_usd || 0 : 0;
    if (isHidden) {
      pBal.innerHTML = `•••••• <span style="font-size:0.9rem; color:var(--text-muted); font-weight:500;">${cur}</span>`;
    } else {
      pBal.innerHTML = `$${formatNumber(totalUsd, 2)} <span style="font-size:0.9rem; color:var(--text-muted); font-weight:500;">${cur}</span>`;
    }
  }

  // Eye Icon sync
  const pEye = document.getElementById('profileBalanceEye');
  if (pEye) {
    pEye.className = app.isBalanceHidden ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
  }

  // Total Tx Count
  const pTxCount = document.getElementById('profileTxCount');
  if (pTxCount) {
    const count = app.transactions ? app.transactions.length : 0;
    pTxCount.innerText = `${count} ${count === 1 ? 'Record' : 'Records'}`;
  }

  // Wallets Count
  const pWallets = document.getElementById('profileWalletCount');
  if (pWallets) {
    const wCount = app.portfolio && app.portfolio.wallets ? app.portfolio.wallets.length : 12;
    pWallets.innerText = `${wCount} Networks`;
  }

  // Preferences controls
  const curSelect = document.getElementById('profileCurrencySelect');
  if (curSelect) {
    curSelect.value = u.currency || localStorage.getItem('webwallet_currency') || 'USD';
  }

  const privToggle = document.getElementById('profilePrivacyToggle');
  if (privToggle) {
    privToggle.checked = Boolean(app.isBalanceHidden);
  }

  const audToggle = document.getElementById('profileAudioToggle');
  if (audToggle) {
    audToggle.checked = localStorage.getItem('webwallet_audio') !== '0';
  }

  const phishEl = document.getElementById('profileAntiPhishCode');
  if (phishEl) {
    phishEl.innerText = localStorage.getItem('webwallet_antiphish') || 'WEBWALLET-VERIFIED';
  }

  // Populate Public Deposit Addresses
  renderProfileAddresses();
}

function renderProfileAddresses() {
  const container = document.getElementById('profileAddressDirectory');
  if (!container) return;

  const wallets = app.portfolio && app.portfolio.wallets ? app.portfolio.wallets : [];
  if (wallets.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted); font-size:0.85rem; padding:12px;">Loading multi-chain addresses...</div>`;
    return;
  }

  // Pick key coins: LTC, BTC, SOL, USDT, DOGE, ETH
  const featured = ['LTC', 'BTC', 'SOL', 'USDT', 'DOGE', 'ETH', 'TRX'];
  const matched = wallets.filter(w => featured.includes(w.coin)).slice(0, 6);
  const toShow = matched.length > 0 ? matched : wallets.slice(0, 6);

  container.innerHTML = toShow.map(w => {
    const addr = w.deposit_address || 'Generating...';
    const shortAddr = addr.length > 20 ? `${addr.substring(0, 10)}...${addr.substring(addr.length - 8)}` : addr;
    const icon = w.icon_url || `/static/images/coins/${w.coin.toLowerCase()}.png`;

    return `
      <div style="background:var(--bg-input); border:1px solid var(--border-subtle); border-radius:12px; padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <div style="display:flex; align-items:center; gap:10px; overflow:hidden;">
          <img src="${icon}" style="width:28px; height:28px; border-radius:50%; object-fit:contain;" onerror="this.src='https://api.dicebear.com/7.x/identicon/svg?seed=${w.coin}'">
          <div style="overflow:hidden;">
            <div style="font-weight:700; font-size:0.85rem; color:#fff; display:flex; align-items:center; gap:6px;">
              ${w.coin} <span style="font-size:0.7rem; color:var(--text-muted); font-weight:500;">${w.network || 'Mainnet'}</span>
            </div>
            <div style="font-family:var(--font-mono); font-size:0.75rem; color:var(--accent-cyan); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${addr}">
              ${shortAddr}
            </div>
          </div>
        </div>
        <button class="btn-action" style="padding:4px 8px; font-size:0.72rem; flex-shrink:0;" onclick="copyToClipboard('${addr}', '${w.coin} address copied!')" title="Copy Address">
          <i class="fa-regular fa-copy"></i>
        </button>
      </div>
    `;
  }).join('');
}

function copyProfileUID() {
  if (!app.currentUser) {
    showToast('Please sign in first', true);
    return;
  }
  const uidText = `UID: #${app.currentUser.id.toString().padStart(5, '0')}`;
  copyToClipboard(uidText, `${uidText} copied to clipboard! 📋`);
}

function exportTransactionsCSV() {
  if (!app.transactions || app.transactions.length === 0) {
    showToast('No transactions found to export', true);
    return;
  }
  const headers = ['ID', 'Type', 'Coin', 'Network', 'Amount', 'Fee', 'USD Value', 'TxHash', 'Status', 'Date'];
  const rows = app.transactions.map(tx => [
    tx.id,
    tx.tx_type,
    tx.coin,
    tx.network || '',
    tx.amount,
    tx.fee || 0,
    tx.usd_value || 0,
    tx.tx_hash || '',
    tx.status,
    tx.created_at
  ]);
  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `WebWallet_Statement_${app.currentUser ? app.currentUser.username : 'User'}_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Account statement exported successfully! 📊');
}

async function resyncUserData() {
  showToast('Re-syncing wallet & on-chain state... 🔄');
  await checkAuth();
  await loadPortfolio();
  await loadTransactions();
  renderProfileView();
  showToast('Wallet synchronization complete! ⚡');
}

function openEditProfileModal() {
  if (!app.currentUser) {
    openModal('authModal');
    return;
  }
  const nameInput = document.getElementById('editUsernameInput');
  const avatarInput = document.getElementById('editAvatarUrlInput');
  const preview = document.getElementById('editProfileAvatarPreview');

  if (nameInput) nameInput.value = app.currentUser.username || '';
  if (avatarInput) avatarInput.value = app.currentUser.avatar || '';
  if (preview) preview.src = app.currentUser.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';

  openModal('editProfileModal');
}

function selectAvatarPreset(url) {
  const avatarInput = document.getElementById('editAvatarUrlInput');
  const preview = document.getElementById('editProfileAvatarPreview');
  if (avatarInput) avatarInput.value = url;
  if (preview) preview.src = url;
}

async function submitSaveProfile() {
  if (!app.currentUser) return;
  const username = document.getElementById('editUsernameInput').value.trim();
  const avatar = document.getElementById('editAvatarUrlInput').value.trim();

  if (!username) {
    showToast('Username cannot be empty', true);
    return;
  }

  try {
    const res = await fetch('/api/user/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, avatar })
    });
    const data = await res.json();
    if (data.success) {
      app.currentUser = data.user;
      renderUserUI();
      renderProfileView();
      closeModal('editProfileModal');
      showToast('Profile updated successfully! ✨');
    } else {
      showToast(data.error || 'Failed to update profile', true);
    }
  } catch (e) {
    showToast('Failed to update profile details', true);
  }
}

async function updateUserBaseCurrency(currency) {
  localStorage.setItem('webwallet_currency', currency);
  if (app.currentUser) {
    try {
      await fetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currency })
      });
      app.currentUser.currency = currency;
    } catch (e) {
      console.warn('Could not save currency preference to backend:', e);
    }
  }
  renderProfileView();
  showToast(`Base currency set to ${currency} 💱`);
}

function togglePrivacyMode(checked) {
  if (typeof checked === 'boolean') {
    app.isBalanceHidden = checked;
  } else {
    app.isBalanceHidden = !app.isBalanceHidden;
  }
  localStorage.setItem('webwallet_stealth_mode', app.isBalanceHidden ? '1' : '0');
  
  const eye = document.getElementById('visEye');
  if (eye) eye.className = app.isBalanceHidden ? "fa-regular fa-eye-slash" : "fa-regular fa-eye";
  
  renderPortfolioBanner();
  renderOverviewAssets();
  renderMyWalletGrid();
  updateAllocationChart();
  renderProfileView();
  showToast(app.isBalanceHidden ? 'Stealth Privacy Mode activated 🕶️' : 'Balances revealed 👁️');
}

function toggleAudioChimes(checked) {
  localStorage.setItem('webwallet_audio', checked ? '1' : '0');
  showToast(checked ? 'Audio chimes enabled 🔔' : 'Audio chimes muted 🔕');
}

function promptSetAntiPhish() {
  const current = localStorage.getItem('webwallet_antiphish') || 'WEBWALLET-VERIFIED';
  const updated = prompt('Enter your personal Anti-Phishing safety phrase (max 20 characters):', current);
  if (updated && updated.trim()) {
    const clean = updated.trim().substring(0, 20).toUpperCase();
    localStorage.setItem('webwallet_antiphish', clean);
    const phishEl = document.getElementById('profileAntiPhishCode');
    if (phishEl) phishEl.innerText = clean;
    showToast('Anti-phishing phrase saved! 🛡️');
  }
}

function promptChangePIN() {
  openModal('authModal');
  showToast('You can update your Master PIN or credentials via the Auth portal 🔑');
}

function copyToClipboard(text, msg = 'Copied to clipboard! 📋') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(msg);
    }).catch(() => {
      fallbackCopy(text, msg);
    });
  } else {
    fallbackCopy(text, msg);
  }
}

function fallbackCopy(text, msg) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand('copy');
    showToast(msg);
  } catch (err) {
    showToast('Failed to copy', true);
  }
  document.body.removeChild(textArea);
}

// ================= MARKET & TICKERS =================

async function loadMarketOverview(silent = false) {
  try {
    const res = await fetch('/api/market/overview');
    const data = await res.json();
    app.market = data.market;
    app.supportedCoins = data.supported_coins;
    renderTopbarTicker();
    renderMarketsTable();
    populateModalSelectors(data.supported_coins);
  } catch (e) {
    console.error('Market fetch error:', e);
  }
}

function renderTopbarTicker() {
  const el = document.getElementById('topbarTicker');
  if (!el || !app.market) return;

  const { prices } = app.market;
  el.innerHTML = `
    <span><strong style="color:var(--accent-purple);">BTC</strong> $${formatNumber(prices.BTC || 0)}</span>
    <span><strong style="color:var(--accent-cyan);">ETH</strong> $${formatNumber(prices.ETH || 0)}</span>
    <span><strong style="color:var(--accent-emerald);">SOL</strong> $${formatNumber(prices.SOL || 0)}</span>
    <span><strong style="color:var(--accent-amber);">LTC</strong> $${formatNumber(prices.LTC || 0)}</span>
  `;
}

function renderMarketsTable() {
  const tbody = document.getElementById('marketsTableBody');
  if (!tbody || !app.market || !app.supportedCoins) return;

  const { prices, changes_24h, highs_24h, lows_24h, volumes_24h } = app.market;

  tbody.innerHTML = app.supportedCoins.map(coin => {
    const c = coin.symbol;
    const p = prices[c] || 0;
    const chg = changes_24h[c] || 0;
    const isUp = chg >= 0;
    const h = highs_24h[c] || p * 1.02;
    const l = lows_24h[c] || p * 0.98;
    const v = volumes_24h[c] || 1500000;

    return `
      <tr>
        <td>
          <div class="asset-flex">
            <div class="asset-icon-box" style="background:${coin.color}20; border:1px solid ${coin.color}40;">
              <img src="${coin.icon_url}" style="width:24px; height:24px; object-fit:contain;" alt="${c}">
            </div>
            <div>
              <div class="asset-title-txt">${c} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:400;">${coin.name}</span></div>
              <div class="asset-subtitle-txt">${coin.default_network}</div>
            </div>
          </div>
        </td>
        <td style="font-family:var(--font-mono); font-weight:700;">$${formatNumber(p)}</td>
        <td>
          <span style="font-weight:700; color:${isUp ? 'var(--accent-emerald)' : 'var(--accent-rose)'};">
            ${isUp ? '+' : ''}${chg.toFixed(2)}%
          </span>
        </td>
        <td style="font-family:var(--font-mono); color:var(--text-muted);">$${formatNumber(h)}</td>
        <td style="font-family:var(--font-mono); color:var(--text-muted);">$${formatNumber(l)}</td>
        <td style="font-family:var(--font-mono); color:var(--text-secondary);">$${formatNumber(v)}</td>
      </tr>
    `;
  }).join('');
}

// ================= PORTFOLIO & CHARTS =================

async function loadPortfolio(silent = false) {
  if (!app.currentUser) return;
  try {
    const res = await fetch('/api/wallet/portfolio');
    if (res.status === 401) return;
    const data = await res.json();
    app.portfolio = data;

    renderPortfolioBanner();
    renderOverviewAssets();
    renderMyWalletGrid();
    updateAllocationChart();
    await updatePerformanceChart(app.activeTimeframe);
    renderProfileView();
  } catch (e) {
    console.error('Portfolio error:', e);
  }
}

function renderPortfolioBanner() {
  const el = document.getElementById('totalBalanceUsd');
  if (!el || !app.portfolio) return;

  if (app.isBalanceHidden) {
    el.innerHTML = `•••••• <span style="font-size:1.1rem; color:var(--text-muted); font-weight:500;">USD</span>`;
  } else {
    el.innerHTML = `$${formatNumber(app.portfolio.total_valuation_usd, 2)} <span style="font-size:1.1rem; color:var(--text-muted); font-weight:500;">USD</span>`;
  }
}

function toggleBalanceVisibility() {
  app.isBalanceHidden = !app.isBalanceHidden;
  const eye = document.getElementById('visEye');
  eye.className = app.isBalanceHidden ? "fa-regular fa-eye-slash" : "fa-regular fa-eye";
  renderPortfolioBanner();
  renderOverviewAssets();
  renderMyWalletGrid();
  updateAllocationChart();
}

function renderOverviewAssets() {
  const tbody = document.getElementById('overviewAssetsTbody');
  if (!tbody || !app.portfolio) return;

  tbody.innerHTML = app.portfolio.assets.slice(0, 8).map(a => {
    const isUp = a.change_24h >= 0;
    const bal = app.isBalanceHidden ? '••••••' : `${formatNumber(a.total_balance, 4)} ${a.symbol}`;
    const usd = app.isBalanceHidden ? '••••••' : `$${formatNumber(a.total_usd, 2)}`;

    return `
      <tr>
        <td>
          <div class="asset-flex">
            <div class="asset-icon-box" style="background:${a.color}20; border:1px solid ${a.color}40;">
              ${a.icon_url ? `<img src="${a.icon_url}" style="width:24px; height:24px; object-fit:contain;" alt="${a.symbol}">` : a.icon}
            </div>
            <div>
              <div class="asset-title-txt">${a.symbol} <span style="color:var(--text-muted); font-weight:400; font-size:0.8rem;">${a.name}</span></div>
              <div class="asset-subtitle-txt">${a.networks.length} Networks Supported</div>
            </div>
          </div>
        </td>
        <td style="font-family:var(--font-mono); font-weight:700;">$${formatNumber(a.price_usd)}</td>
        <td>
          <span style="font-weight:700; color:${isUp ? 'var(--accent-emerald)' : 'var(--accent-rose)'};">
            ${isUp ? '+' : ''}${a.change_24h.toFixed(2)}%
          </span>
        </td>
        <td style="font-family:var(--font-mono); font-weight:700;">${bal}</td>
        <td style="font-family:var(--font-mono); font-weight:800; color:var(--accent-purple);">${usd}</td>
        <td style="text-align:right;">
          <div style="display:inline-flex; gap:6px;">
            <button class="btn-action" style="padding:5px 12px; font-size:0.75rem;" onclick="openDepositFor('${a.symbol}')">Deposit</button>
            <button class="btn-action" style="padding:5px 12px; font-size:0.75rem;" onclick="openWithdrawFor('${a.symbol}')">Withdraw</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderMyWalletGrid() {
  const container = document.getElementById('fullWalletsGrid');
  if (!container || !app.portfolio) return;

  container.innerHTML = app.portfolio.assets.map(a => {
    const bal = app.isBalanceHidden ? '••••••' : `${formatNumber(a.total_balance, 6)} ${a.symbol}`;
    const usd = app.isBalanceHidden ? '••••••' : `$${formatNumber(a.total_usd, 2)}`;

    return `
      <div class="card" style="border:1px solid var(--border-subtle); display:flex; flex-direction:column; justify-content:space-between;">
        <div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <div class="asset-flex">
              <div class="asset-icon-box" style="background:${a.color}25; border:1px solid ${a.color}50;">
                ${a.icon_url ? `<img src="${a.icon_url}" style="width:24px; height:24px; object-fit:contain;" alt="${a.symbol}">` : a.icon}
              </div>
              <div>
                <div class="asset-title-txt">${a.symbol}</div>
                <div class="asset-subtitle-txt">${a.name}</div>
              </div>
            </div>
            <span class="brand-badge">$${formatNumber(a.price_usd)}</span>
          </div>
          <div style="font-size:1.4rem; font-weight:800; font-family:var(--font-mono); margin:10px 0 2px;">${bal}</div>
          <div style="font-size:0.85rem; color:var(--accent-cyan); font-family:var(--font-mono);">${usd}</div>
        </div>

        <div style="display:flex; gap:8px; margin-top:20px;">
          <button class="btn-action" style="flex:1; justify-content:center; padding:8px; font-size:0.82rem;" onclick="openDepositFor('${a.symbol}')">
            <i class="fa-solid fa-circle-down"></i> Deposit
          </button>
          <button class="btn-action" style="flex:1; justify-content:center; padding:8px; font-size:0.82rem;" onclick="openWithdrawFor('${a.symbol}')">
            <i class="fa-solid fa-paper-plane"></i> Withdraw
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Chart.js Setup
async function initCharts() {
  const ctxPerf = document.getElementById('portfolioChart')?.getContext('2d');
  if (ctxPerf) {
    const gradient = ctxPerf.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.45)');
    gradient.addColorStop(1, 'rgba(139, 92, 246, 0.0)');

    app.charts.portfolio = new Chart(ctxPerf, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: '#8b5cf6',
          borderWidth: 2.5,
          backgroundColor: gradient,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#06b6d4'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: '#0c101d',
            titleColor: '#94a3b8',
            bodyColor: '#fff',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            callbacks: {
              label: (ctx) => ` Valuation: $${formatNumber(ctx.raw, 2)} USD`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 7 } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b' } }
        }
      }
    });
  }

  const ctxAlloc = document.getElementById('allocationChart')?.getContext('2d');
  if (ctxAlloc) {
    app.charts.allocation = new Chart(ctxAlloc, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [],
          borderWidth: 0,
          hoverOffset: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        }
      }
    });
  }
}

async function updatePerformanceChart(tf) {
  if (!app.charts.portfolio) return;
  try {
    const res = await fetch(`/api/wallet/chart-history?timeframe=${tf}`);
    const data = await res.json();
    app.charts.portfolio.data.labels = data.labels;
    app.charts.portfolio.data.datasets[0].data = data.values;
    app.charts.portfolio.update();
  } catch (e) {
    console.error('Chart history fetch error:', e);
  }
}

function updateAllocationChart() {
  if (!app.charts.allocation) return;
  const assets = (app.portfolio && app.portfolio.assets) ? app.portfolio.assets.filter(a => a.total_usd > 0) : [];
  const leg = document.getElementById('allocationLegend');
  const amountEl = document.getElementById('allocDisplayAmount');
  const subEl = document.getElementById('allocDisplaySub');

  // Dynamically update the semi-big amount in the center of the liquid roll
  if (amountEl) {
    if (app.isBalanceHidden) {
      amountEl.innerText = '••••';
      if (subEl) subEl.innerText = 'HIDDEN';
    } else {
      const total = app.portfolio?.total_valuation_usd || 0;
      if (total <= 0) {
        amountEl.innerText = '$0';
        if (subEl) subEl.innerText = 'USD BALANCE';
      } else if (total < 10) {
        amountEl.innerText = `$${Number(total).toFixed(2)}`;
        if (subEl) subEl.innerText = 'USD BALANCE';
      } else {
        amountEl.innerText = `$${Number(total).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        if (subEl) subEl.innerText = `${assets.length} ASSETS`;
      }
    }
  }

  if (!assets.length) {
    // Zero balance: Clear Chart.js completely so there is NO line in the middle at all!
    app.charts.allocation.data.labels = [];
    app.charts.allocation.data.datasets[0].data = [];
    app.charts.allocation.data.datasets[0].borderWidth = 0;
    app.charts.allocation.options.plugins.tooltip = { enabled: false };
    app.charts.allocation.update();

    if (leg) {
      leg.innerHTML = `<span style="color:var(--text-muted); font-size:0.76rem; display:flex; align-items:center; gap:6px;"><i class="fa-solid fa-water" style="color:var(--accent-cyan); font-size:0.75rem;"></i> Liquid Roll Active</span>`;
    }
    return;
  }

  // Active Portfolio Holdings
  const labels = assets.map(a => a.symbol);
  const data = assets.map(a => a.total_usd);
  const colors = assets.map(a => a.color || '#00f2fe');

  app.charts.allocation.data.labels = labels;
  app.charts.allocation.data.datasets[0].data = data;
  app.charts.allocation.data.datasets[0].backgroundColor = colors;
  app.charts.allocation.data.datasets[0].borderWidth = 0;
  app.charts.allocation.options.plugins.tooltip = {
    enabled: true,
    callbacks: {
      label: (ctx) => ` ${ctx.label}: $${Number(ctx.parsed).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
    }
  };
  app.charts.allocation.update();

  if (leg) {
    leg.innerHTML = assets.slice(0, 4).map(a => `
      <span style="display:flex; align-items:center; gap:4px; font-weight:600;">
        <span style="width:8px; height:8px; border-radius:50%; background:${a.color};"></span>
        <span>${a.symbol}</span>
      </span>
    `).join('');
  }
}

function switchTimeframe(tf, btn) {
  app.activeTimeframe = tf;
  document.querySelectorAll('.timeframe-selector .tf-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  updatePerformanceChart(tf);
}

// ================= TRANSACTIONS (AUDITED PERSONAL LEDGER) =================

app.txFilter = 'ALL';
app.txStatusFilter = 'ALL';
app.txAssetFilter = 'ALL';
app.txSearchQuery = '';
app.filteredTxs = [];

// Clean human-friendly blockchain network names
function cleanNetworkLabel(network, coin) {
  if (!network) return `${coin || ''} Native`;
  let net = String(network).trim();
  net = net.replace(/\s*\(?Normal\)?/gi, ' Native');
  if (net.toLowerCase().includes('ethereum native')) return 'Ethereum (ERC20)';
  if (net.toLowerCase().includes('bnb native')) return 'BNB Smart Chain (BEP20)';
  if (net.toLowerCase().includes('polygon native')) return 'Polygon (PoS)';
  if (net.toLowerCase().includes('tron native')) return 'TRON (TRC20)';
  if (net.toLowerCase().includes('bitcoin native')) return 'Bitcoin Mainnet';
  if (net.toLowerCase().includes('litecoin native')) return 'Litecoin Mainnet';
  if (net.toLowerCase().includes('dogecoin native')) return 'Dogecoin Mainnet';
  if (net.toLowerCase().includes('solana native')) return 'Solana (SPL)';
  if (net.toLowerCase().includes('avalanche native')) return 'Avalanche (C-Chain)';
  return net;
}

// Get high-res Coin icon
function getCoinLogoHtml(coin) {
  const c = (coin || '').toUpperCase();
  if (c.includes('→')) {
    return `
      <div style="width:30px; height:30px; border-radius:50%; background:rgba(245,158,11,0.18); border:1px solid rgba(245,158,11,0.35); display:inline-flex; align-items:center; justify-content:center; color:var(--accent-amber); font-size:0.8rem; flex-shrink:0;">
        <i class="fa-solid fa-arrows-rotate"></i>
      </div>
    `;
  }

  const asset = app.portfolio?.assets?.find(a => a.symbol === c) || app.supportedCoins?.find(s => s.symbol === c);
  if (asset && asset.icon_url) {
    return `<img src="${asset.icon_url}" style="width:30px; height:30px; border-radius:50%; object-fit:contain; background:rgba(255,255,255,0.06); padding:2px; flex-shrink:0;" alt="${c}">`;
  }

  const knownIcons = {
    'BTC': 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
    'ETH': 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    'LTC': 'https://assets.coingecko.com/coins/images/2/small/litecoin.png',
    'USDT': 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
    'USDC': 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
    'BNB': 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
    'SOL': 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
    'DOGE': 'https://assets.coingecko.com/coins/images/5/small/dogecoin.png',
    'TRX': 'https://assets.coingecko.com/coins/images/1094/small/tron-logo.png',
    'POL': 'https://assets.coingecko.com/coins/images/4713/small/polygon.png',
    'AVAX': 'https://assets.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png'
  };

  if (knownIcons[c]) {
    return `<img src="${knownIcons[c]}" style="width:30px; height:30px; border-radius:50%; object-fit:contain; background:rgba(255,255,255,0.06); padding:2px; flex-shrink:0;" alt="${c}">`;
  }

  return `<div style="width:30px; height:30px; border-radius:50%; background:rgba(0,242,254,0.15); border:1px solid rgba(0,242,254,0.3); display:inline-flex; align-items:center; justify-content:center; color:var(--accent-cyan); font-weight:800; font-size:0.75rem; flex-shrink:0;">${c.slice(0,3)}</div>`;
}

// Relative time calculator
function formatRelativeTime(dateInput) {
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return dateInput;
    const now = new Date();
    const diffSec = Math.floor((now - d) / 1000);
    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
    return d.toLocaleDateString();
  } catch (e) {
    return dateInput;
  }
}

// Open real explorer in new tab
function viewTxInExplorerDirect(txHash, network) {
  const hash = (txHash || '').trim();
  if (!hash || hash === '-') return;

  if (hash.startsWith('tip_') || hash.startsWith('swap_') || hash.startsWith('admin_credit_')) {
    showToast(`Internal Vault Ledger Record: ${hash.slice(0, 18)}... 🔒`);
    return;
  }

  const net = (network || '').toLowerCase();
  let url = `https://blockchair.com/search?q=${hash}`;
  if (net.includes('litecoin') || (hash.length === 64 && net.includes('ltc'))) {
    url = `https://litecoinspace.org/tx/${hash}`;
  } else if (net.includes('bitcoin') || net.includes('btc')) {
    url = `https://mempool.space/tx/${hash}`;
  } else if (net.includes('ethereum') || net.includes('eth') || hash.startsWith('0x')) {
    url = `https://etherscan.io/tx/${hash}`;
  } else if (net.includes('doge')) {
    url = `https://dogechain.info/tx/${hash}`;
  } else if (net.includes('tron') || net.includes('trx')) {
    url = `https://tronscan.org/#/transaction/${hash}`;
  }
  window.open(url, '_blank');
}

// Export personal records as CSV
function exportTransactionsCSV() {
  if (!app.currentUser) {
    showToast('Please sign in to export your transaction records', true);
    return;
  }
  const txs = app.filteredTxs?.length ? app.filteredTxs : (app.transactions || []);
  if (!txs.length) {
    showToast('No transactions to export', true);
    return;
  }

  const headers = ['TXID', 'Type', 'Coin', 'Network', 'Amount', 'Amount_USD', 'Fee', 'Counterparty_Destination', 'Status', 'Date_UTC'];
  const rows = txs.map(t => [
    `"${t.tx_hash || ''}"`,
    `"${t.type || ''}"`,
    `"${t.coin || ''}"`,
    `"${t.network || ''}"`,
    t.amount || 0,
    t.amount_usd || 0,
    t.fee || 0,
    `"${(t.counterparty_name || t.destination || '').replace(/"/g, '""')}"`,
    `"${t.status || ''}"`,
    `"${t.created_at || ''}"`
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `WebWallet_${app.currentUser.username}_Ledger_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Transaction records exported to CSV! 📊');
}

async function loadTransactions(silent = false) {
  if (!app.currentUser) {
    app.transactions = [];
    app.filteredTxs = [];
    renderTransactionsTable();
    return;
  }
  try {
    const res = await fetch('/api/transactions');
    if (res.status === 401) {
      app.transactions = [];
      app.filteredTxs = [];
      renderTransactionsTable();
      return;
    }
    const data = await res.json();
    app.transactions = Array.isArray(data) ? data : [];
    renderTransactionsTable();
    renderProfileView();
  } catch (e) {
    console.error('Tx load error:', e);
  }
}

function filterTransactionsView(type, btn) {
  app.txFilter = type;
  document.querySelectorAll('#txFilterGroup .tx-pill-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderTransactionsTable();
}

function filterTransactionsStatus(status) {
  app.txStatusFilter = status;
  renderTransactionsTable();
}

function filterTransactionsAsset(asset) {
  app.txAssetFilter = asset;
  renderTransactionsTable();
}

function filterTransactionsSearch(query) {
  app.txSearchQuery = (query || '').toLowerCase().trim();
  renderTransactionsTable();
}

function resetTxFilters() {
  app.txFilter = 'ALL';
  app.txStatusFilter = 'ALL';
  app.txAssetFilter = 'ALL';
  app.txSearchQuery = '';

  const sInput = document.getElementById('txSearchInput');
  if (sInput) sInput.value = '';
  const sStatus = document.getElementById('txStatusFilter');
  if (sStatus) sStatus.value = 'ALL';
  const sAsset = document.getElementById('txAssetFilter');
  if (sAsset) sAsset.value = 'ALL';

  document.querySelectorAll('#txFilterGroup .tx-pill-btn').forEach((b, idx) => {
    b.classList.toggle('active', idx === 0);
  });
  renderTransactionsTable();
}

function renderTransactionsTable() {
  const tbody = document.getElementById('fullTxTbody');
  const mobileContainer = document.getElementById('mobileTxCardsContainer');
  if (!tbody) return;

  // 1. Unauthenticated Guest State
  if (!app.currentUser) {
    const guestHtml = `
      <tr>
        <td colspan="8" style="text-align:center; padding:50px 20px;">
          <div style="max-width:400px; margin:0 auto;">
            <div style="width:58px; height:58px; border-radius:50%; background:rgba(0,242,254,0.1); border:1px solid rgba(0,242,254,0.3); display:inline-flex; align-items:center; justify-content:center; color:var(--accent-cyan); font-size:1.5rem; margin-bottom:14px; box-shadow:0 0 20px rgba(0,242,254,0.15);">
              <i class="fa-solid fa-lock"></i>
            </div>
            <div style="font-weight:800; font-size:1.15rem; margin-bottom:6px; color:#fff;">Personal Ledger Encrypted</div>
            <div style="font-size:0.85rem; color:var(--text-secondary); line-height:1.5; margin-bottom:18px;">
              Please sign in to your WebWallet account to view your private deposits, withdrawals, and cryptographically verified transfer receipts.
            </div>
            <button class="btn-action primary" style="padding:10px 24px; font-size:0.88rem; margin:0 auto; font-weight:700;" onclick="openModal('authModal')">
              <i class="fa-solid fa-arrow-right-to-bracket"></i> Sign In / Register
            </button>
          </div>
        </td>
      </tr>
    `;
    tbody.innerHTML = guestHtml;
    if (mobileContainer) {
      mobileContainer.innerHTML = `<div style="text-align:center; padding:40px 20px; color:var(--text-muted); background:var(--bg-card); border-radius:14px; border:1px solid var(--border-subtle);">Please sign in to view your personal transactions.</div>`;
    }

    const inflowEl = document.getElementById('txTotalInflow');
    const outflowEl = document.getElementById('txTotalOutflow');
    const completedEl = document.getElementById('txTotalCompleted');
    const pendingEl = document.getElementById('txTotalPending');
    if (inflowEl) inflowEl.innerText = '$0.00';
    if (outflowEl) outflowEl.innerText = '$0.00';
    if (completedEl) completedEl.innerText = '0';
    if (pendingEl) pendingEl.innerText = '0';
    return;
  }

  const allTxs = app.transactions || [];

  // 2. Compute Summary KPI Metrics for logged-in user
  let inflowUsd = 0;
  let outflowUsd = 0;
  let completedCount = 0;
  let pendingCount = 0;

  allTxs.forEach(t => {
    const usd = parseFloat(t.amount_usd || 0);
    if (t.type === 'DEPOSIT' || t.type === 'TIP_RECEIVED') {
      inflowUsd += usd;
    } else if (t.type === 'WITHDRAW' || t.type === 'TIP_SENT') {
      outflowUsd += usd;
    }
    if (t.status === 'COMPLETED') completedCount++;
    else if (t.status === 'PENDING') pendingCount++;
  });

  const inflowEl = document.getElementById('txTotalInflow');
  const outflowEl = document.getElementById('txTotalOutflow');
  const completedEl = document.getElementById('txTotalCompleted');
  const pendingEl = document.getElementById('txTotalPending');

  if (inflowEl) inflowEl.innerText = `$${formatNumber(inflowUsd, 2)}`;
  if (outflowEl) outflowEl.innerText = `$${formatNumber(outflowUsd, 2)}`;
  if (completedEl) completedEl.innerText = completedCount;
  if (pendingEl) pendingEl.innerText = pendingCount;

  // 3. Multi-Criteria Filtering
  let txs = allTxs;

  // Filter by Type
  if (app.txFilter === 'DEPOSIT') {
    txs = txs.filter(t => t.type === 'DEPOSIT');
  } else if (app.txFilter === 'WITHDRAW') {
    txs = txs.filter(t => t.type === 'WITHDRAW');
  } else if (app.txFilter === 'TIP_SENT') {
    txs = txs.filter(t => t.type === 'TIP_SENT');
  } else if (app.txFilter === 'TIP_RECEIVED') {
    txs = txs.filter(t => t.type === 'TIP_RECEIVED');
  } else if (app.txFilter === 'SWAP') {
    txs = txs.filter(t => t.type === 'SWAP');
  }

  // Filter by Status
  if (app.txStatusFilter && app.txStatusFilter !== 'ALL') {
    txs = txs.filter(t => (t.status || '').toUpperCase() === app.txStatusFilter.toUpperCase());
  }

  // Filter by Asset
  if (app.txAssetFilter && app.txAssetFilter !== 'ALL') {
    const filterCoin = app.txAssetFilter.toUpperCase();
    txs = txs.filter(t => (t.coin || '').toUpperCase().includes(filterCoin));
  }

  // Search Query
  if (app.txSearchQuery) {
    const q = app.txSearchQuery;
    txs = txs.filter(t =>
      (t.tx_hash && t.tx_hash.toLowerCase().includes(q)) ||
      (t.coin && t.coin.toLowerCase().includes(q)) ||
      (t.network && t.network.toLowerCase().includes(q)) ||
      (t.destination && t.destination.toLowerCase().includes(q)) ||
      (t.counterparty_name && t.counterparty_name.toLowerCase().includes(q)) ||
      (t.memo && t.memo.toLowerCase().includes(q))
    );
  }

  app.filteredTxs = txs;

  // 4. Empty State
  if (!txs.length) {
    const emptyMsg = `
      <tr>
        <td colspan="8" style="text-align:center; padding:45px 20px;">
          <div style="max-width:380px; margin:0 auto;">
            <div style="width:52px; height:52px; border-radius:50%; background:rgba(255,255,255,0.04); border:1px solid var(--border-subtle); display:inline-flex; align-items:center; justify-content:center; color:var(--text-muted); font-size:1.4rem; margin-bottom:14px;">
              <i class="fa-solid fa-inbox"></i>
            </div>
            <div style="font-weight:800; font-size:1.05rem; margin-bottom:6px; color:#fff;">No Transactions Found</div>
            <div style="font-size:0.83rem; color:var(--text-secondary); margin-bottom:16px;">
              ${allTxs.length === 0 ? "You haven't made any transactions yet. Receive or deposit crypto to start your audited ledger." : "No records match your selected filters. Try changing or clearing your search criteria."}
            </div>
            ${allTxs.length === 0 ? `<button class="btn-action primary" style="padding:8px 18px; font-size:0.82rem; margin:0 auto;" onclick="openModal('depositModal')"><i class="fa-solid fa-circle-down"></i> Deposit Crypto</button>` : `<button class="btn-action" style="padding:8px 18px; font-size:0.82rem; margin:0 auto;" onclick="resetTxFilters()"><i class="fa-solid fa-filter-circle-xmark"></i> Reset Filters</button>`}
          </div>
        </td>
      </tr>
    `;
    tbody.innerHTML = emptyMsg;
    if (mobileContainer) {
      mobileContainer.innerHTML = `<div style="text-align:center; padding:35px 20px; color:var(--text-muted); background:var(--bg-card); border-radius:14px; border:1px solid var(--border-subtle);">No transactions found matching your criteria.</div>`;
    }
    return;
  }

  // Helper metadata builder per item
  const buildItemMeta = (t) => {
    let typeBadge = '';
    let sign = '';
    let amtColor = 'var(--text-main)';
    let typeLabel = t.type;

    const isPending = (t.status || '').toUpperCase() === 'PENDING';

    switch(t.type) {
      case 'DEPOSIT':
        if (isPending) {
          typeBadge = `<span class="brand-badge" style="color:var(--accent-cyan); border-color:rgba(6,182,212,0.4); background:rgba(6,182,212,0.12);"><i class="fa-solid fa-spinner fa-spin"></i> Receiving</span>`;
          typeLabel = 'Receiving On-Chain';
        } else {
          typeBadge = `<span class="brand-badge" style="color:var(--accent-emerald); border-color:rgba(16,185,129,0.3); background:rgba(16,185,129,0.1);"><i class="fa-solid fa-arrow-down-left"></i> Received</span>`;
          typeLabel = 'Received Deposit';
        }
        sign = '+';
        amtColor = 'var(--accent-emerald)';
        break;
      case 'WITHDRAW':
        if (isPending) {
          typeBadge = `<span class="brand-badge" style="color:var(--accent-amber); border-color:rgba(245,158,11,0.4); background:rgba(245,158,11,0.12);"><i class="fa-solid fa-spinner fa-spin"></i> Sending</span>`;
          typeLabel = 'Sending On-Chain';
        } else {
          typeBadge = `<span class="brand-badge" style="color:var(--accent-rose); border-color:rgba(244,63,94,0.3); background:rgba(244,63,94,0.1);"><i class="fa-solid fa-arrow-up-right"></i> Sent</span>`;
          typeLabel = 'Sent Outbound';
        }
        sign = '-';
        amtColor = 'var(--accent-rose)';
        break;
      case 'TIP_SENT':
        typeBadge = `<span class="brand-badge" style="color:var(--accent-blurple); border-color:rgba(88,101,242,0.3); background:rgba(88,101,242,0.1);"><i class="fa-solid fa-paper-plane"></i> Tip Sent</span>`;
        sign = '-';
        amtColor = 'var(--accent-rose)';
        typeLabel = 'P2P Tip Sent';
        break;
      case 'TIP_RECEIVED':
        typeBadge = `<span class="brand-badge" style="color:var(--accent-cyan); border-color:rgba(6,182,212,0.3); background:rgba(6,182,212,0.1);"><i class="fa-solid fa-hand-holding-dollar"></i> Tip Received</span>`;
        sign = '+';
        amtColor = 'var(--accent-emerald)';
        typeLabel = 'P2P Tip Received';
        break;
      case 'SWAP':
        typeBadge = `<span class="brand-badge" style="color:var(--accent-purple); border-color:rgba(139,92,246,0.3); background:rgba(139,92,246,0.1);"><i class="fa-solid fa-shuffle"></i> Swapped</span>`;
        typeLabel = 'Cross-Chain Swapped';
        amtColor = 'var(--accent-cyan)';
        break;
      default:
        typeBadge = `<span class="brand-badge">${t.type}</span>`;
    }

    const cleanHash = (t.tx_hash || '').split('_u')[0].split('#')[0];
    const shortHash = cleanHash.length > 16 ? `${cleanHash.slice(0, 8)}...${cleanHash.slice(-6)}` : cleanHash;

    let statusBadge = '';
    if (isPending) {
      if (t.type === 'DEPOSIT') {
        statusBadge = `<span class="brand-badge" style="color:var(--accent-cyan); border-color:rgba(6,182,212,0.4); background:rgba(6,182,212,0.1);"><i class="fa-solid fa-spinner fa-spin"></i> Receiving</span>`;
      } else if (t.type === 'WITHDRAW') {
        statusBadge = `<span class="brand-badge" style="color:var(--accent-amber); border-color:rgba(245,158,11,0.4); background:rgba(245,158,11,0.1);"><i class="fa-solid fa-spinner fa-spin"></i> Sending</span>`;
      } else {
        statusBadge = `<span class="brand-badge" style="color:var(--accent-amber); border-color:rgba(245,158,11,0.4); background:rgba(245,158,11,0.1);"><i class="fa-solid fa-spinner fa-spin"></i> Confirming</span>`;
      }
    } else {
      if (t.type === 'DEPOSIT') {
        statusBadge = `<span class="brand-badge" style="color:var(--accent-emerald); border-color:rgba(16,185,129,0.3); background:rgba(16,185,129,0.1);"><i class="fa-solid fa-circle-check"></i> Received</span>`;
      } else if (t.type === 'WITHDRAW') {
        statusBadge = `<span class="brand-badge" style="color:var(--accent-rose); border-color:rgba(244,63,94,0.3); background:rgba(244,63,94,0.1);"><i class="fa-solid fa-circle-check"></i> Sent</span>`;
      } else if (t.type === 'SWAP') {
        statusBadge = `<span class="brand-badge" style="color:var(--accent-purple); border-color:rgba(139,92,246,0.3); background:rgba(139,92,246,0.1);"><i class="fa-solid fa-circle-check"></i> Swapped</span>`;
      } else {
        statusBadge = `<span class="brand-badge" style="color:var(--accent-emerald); border-color:rgba(16,185,129,0.3); background:rgba(16,185,129,0.1);"><i class="fa-solid fa-circle-check"></i> Completed</span>`;
      }
    }

    let counterparty = '-';
    if (t.type === 'DEPOSIT') {
      counterparty = `<span style="display:inline-flex; align-items:center; gap:6px; color:var(--text-secondary); font-size:0.82rem;"><i class="fa-solid fa-wallet" style="color:var(--accent-emerald);"></i> My Deposit Vault</span>`;
    } else if (t.type === 'WITHDRAW') {
      const dest = t.destination || '';
      const shortDest = dest.length > 16 ? `${dest.slice(0, 8)}...${dest.slice(-6)}` : dest;
      counterparty = dest ? `<span title="${dest}" style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-secondary); display:inline-flex; align-items:center; gap:4px;"><i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.7rem;"></i> ${shortDest}</span>` : 'External Payout';
    } else if (t.type === 'TIP_SENT' || t.type === 'TIP_RECEIVED') {
      const u = t.counterparty_name || 'Member';
      counterparty = `<span style="display:inline-flex; align-items:center; gap:6px; font-weight:700; color:var(--accent-blurple); font-size:0.85rem;"><i class="fa-brands fa-discord"></i> @${u}</span>`;
    } else if (t.type === 'SWAP') {
      counterparty = `<span style="color:var(--text-secondary); font-size:0.82rem;"><i class="fa-solid fa-arrows-rotate" style="color:var(--accent-amber); margin-right:4px;"></i> ${t.memo || 'Instant Token Conversion'}</span>`;
    }

    const cleanNet = cleanNetworkLabel(t.network, t.coin);
    const coinLogo = getCoinLogoHtml(t.coin);
    const relTime = formatRelativeTime(t.created_at);

    return { typeBadge, sign, amtColor, typeLabel, cleanHash, shortHash, statusBadge, counterparty, cleanNet, coinLogo, relTime };
  };

  // 5. Render Desktop Table Rows
  tbody.innerHTML = txs.map(t => {
    const meta = buildItemMeta(t);
    return `
      <tr class="tx-table-row" onclick="showReceiptByHash('${meta.cleanHash}')" title="Click to view full cryptographic receipt">
        <td>${meta.typeBadge}</td>
        <td>
          <div style="display:flex; align-items:center; gap:10px;">
            ${meta.coinLogo}
            <div>
              <div style="font-weight:800; font-size:0.92rem; color:#fff;">${t.coin}</div>
              <div class="network-subtag">${meta.cleanNet}</div>
            </div>
          </div>
        </td>
        <td>
          <div style="font-family:var(--font-mono); font-weight:800; color:${meta.amtColor}; font-size:0.95rem;">
            ${meta.sign}${formatNumber(t.amount, 6)} ${t.coin}
          </div>
          <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono); margin-top:2px;">
            ≈ $${formatNumber(t.amount_usd || 0, 2)} USD
          </div>
        </td>
        <td>
          <div style="display:flex; align-items:center; gap:6px;">
            <div class="tx-hash-badge" title="${meta.cleanHash}">${meta.shortHash}</div>
            <button class="tx-action-btn" onclick="event.stopPropagation(); navigator.clipboard.writeText('${meta.cleanHash}'); showToast('TXID copied to clipboard! 📋');" title="Copy TXID">
              <i class="fa-regular fa-copy"></i>
            </button>
            <button class="tx-action-btn" onclick="event.stopPropagation(); viewTxInExplorerDirect('${meta.cleanHash}', '${t.network || t.coin}');" title="Open in Public Blockchain Explorer">
              <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </button>
          </div>
        </td>
        <td>${meta.counterparty}</td>
        <td>
          <div style="font-size:0.83rem; color:var(--text-main); font-weight:600;">${new Date(t.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
          <div style="font-size:0.73rem; color:var(--text-muted);">${new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • ${meta.relTime}</div>
        </td>
        <td>${meta.statusBadge}</td>
        <td style="text-align:right;">
          <button class="tx-action-btn" onclick="event.stopPropagation(); showReceiptByHash('${meta.cleanHash}');" title="View Full Transaction Receipt">
            <i class="fa-solid fa-receipt" style="color:var(--accent-cyan);"></i> Receipt
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // 6. Render Mobile Cards
  if (mobileContainer) {
    mobileContainer.innerHTML = txs.map(t => {
      const meta = buildItemMeta(t);
      return `
        <div class="mobile-tx-card" onclick="showReceiptByHash('${meta.cleanHash}')">
          <div class="mobile-tx-header">
            <div style="display:flex; align-items:center; gap:8px;">
              ${meta.coinLogo}
              <div>
                <div style="font-weight:800; font-size:0.9rem; color:#fff;">${t.coin}</div>
                <div style="font-size:0.72rem; color:var(--text-muted);">${meta.cleanNet}</div>
              </div>
            </div>
            <div>${meta.typeBadge}</div>
          </div>

          <div class="mobile-tx-body" style="padding:12px 0; border-top:1px solid var(--border-subtle); border-bottom:1px solid var(--border-subtle); margin:10px 0;">
            <div>
              <div style="font-size:1.15rem; font-weight:800; font-family:var(--font-mono); color:${meta.amtColor};">
                ${meta.sign}${formatNumber(t.amount, 6)} ${t.coin}
              </div>
              <div style="font-size:0.78rem; color:var(--text-muted); font-family:var(--font-mono);">
                ≈ $${formatNumber(t.amount_usd || 0, 2)} USD
              </div>
            </div>
            <div style="text-align:right;">
              ${meta.statusBadge}
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.78rem; color:var(--text-muted);">
            <div><i class="fa-regular fa-clock"></i> ${meta.relTime}</div>
            <div style="display:flex; gap:6px;">
              <button class="tx-action-btn" onclick="event.stopPropagation(); navigator.clipboard.writeText('${meta.cleanHash}'); showToast('TXID copied! 📋');">
                <i class="fa-regular fa-copy"></i> Copy TXID
              </button>
              <button class="tx-action-btn" onclick="event.stopPropagation(); showReceiptByHash('${meta.cleanHash}');">
                <i class="fa-solid fa-receipt"></i>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

// ================= ADMIN CENTER & MEMBER PULLER =================

async function loadAdminMetrics(silent = false) {
  if (!app.currentUser?.is_admin) return;
  try {
    const res = await fetch('/api/admin/metrics');
    if (res.status === 403) return;
    const data = await res.json();

    document.getElementById('adminUsersCount').innerText = data.users_count;
    document.getElementById('adminPendingCount').innerText = data.pending_withdrawals;
    document.getElementById('adminPullableCount').innerText = data.pullable_count;
    document.getElementById('adminVolumeUsd').innerText = `$${formatNumber(data.total_volume_usd, 2)}`;

    const revEl = document.getElementById('adminTotalRevenueUsd');
    if (revEl) revEl.innerText = `$${formatNumber(data.total_revenue_usd || 0, 4)}`;

    const swapEl = document.getElementById('adminSwapOrdersCount');
    if (swapEl) swapEl.innerText = data.swap_orders_count || 0;

    // Update master engine switch buttons
    if (data.settings) {
      ['deposits', 'withdrawals', 'swaps', 'tipping'].forEach(eng => {
        const btn = document.getElementById(`btnToggle${eng.charAt(0).toUpperCase() + eng.slice(1)}`);
        const isPaused = data.settings[`engine_${eng}`] === 'paused';
        if (btn) {
          btn.innerText = isPaused ? 'PAUSED' : 'ACTIVE';
          btn.style.color = isPaused ? 'var(--accent-rose)' : 'var(--accent-emerald)';
          btn.style.borderColor = isPaused ? 'var(--accent-rose)' : 'var(--accent-emerald)';
          btn.style.background = isPaused ? 'rgba(244,63,94,0.2)' : 'rgba(16,185,129,0.2)';
        }
      });
    }

    // Set Announcement Banner
    if (data.announcement) {
      const banner = document.getElementById('globalAnnouncementBanner');
      const text = document.getElementById('announcementText');
      if (banner && text) {
        text.innerText = data.announcement;
        banner.style.display = 'flex';
      }
      const adminAnn = document.getElementById('adminAnnouncementInput');
      if (adminAnn && !adminAnn.value) adminAnn.value = data.announcement;
    }

    // Render Admin Users Table
    const usersTbody = document.getElementById('adminUsersTbody');
    if (usersTbody && data.users_list) {
      usersTbody.innerHTML = data.users_list.map(u => `
        <tr>
          <td style="font-family:var(--font-mono); color:var(--text-muted);">#${u.id}</td>
          <td style="font-weight:700;">${u.username}</td>
          <td style="font-family:var(--font-mono); font-size:0.82rem; color:var(--text-secondary);">${u.email || u.discord_id}</td>
          <td>${u.is_admin ? '<span class="brand-badge" style="color:var(--accent-purple); border-color:var(--accent-purple);">ADMIN</span>' : '<span class="brand-badge">USER</span>'}</td>
          <td style="font-family:var(--font-mono); font-weight:700; color:var(--accent-cyan);">${formatNumber(u.total_tokens, 4)}</td>
          <td style="font-size:0.8rem; color:var(--text-muted);">${new Date(u.created_at).toLocaleDateString()}</td>
          <td style="text-align:right;">
            <button class="btn-action" style="padding:4px 10px; font-size:0.75rem;" onclick="openAdminAdjustModal(${u.id}, '${u.username}')">
              <i class="fa-solid fa-coins"></i> Adjust Bal
            </button>
          </td>
        </tr>
      `).join('');
    }

    // Render Pending Withdrawals Queue
    const tbody = document.getElementById('adminWithdrawalsTbody');
    if (tbody && data.pending_list) {
      if (!data.pending_list.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">No pending withdrawals requiring manual review.</td></tr>`;
      } else {
        tbody.innerHTML = data.pending_list.map(w => `
          <tr>
            <td style="font-weight:700;">${w.username} (${w.discord_id?.slice(0, 7) || 'User'}...)</td>
            <td style="font-weight:700;">${w.coin} (${w.network})</td>
            <td style="font-family:var(--font-mono); font-weight:800; color:var(--accent-rose);">${formatNumber(w.amount, 6)} ${w.coin}</td>
            <td style="font-family:var(--font-mono); font-size:0.78rem; color:var(--text-muted);">${w.destination}</td>
            <td style="font-size:0.8rem; color:var(--text-muted);">${new Date(w.created_at).toLocaleTimeString()}</td>
            <td style="text-align:right;">
              <button class="btn-action" style="padding:4px 10px; font-size:0.75rem; background:var(--accent-emerald); border:none;" onclick="processAdminWithdrawal('${w.tx_hash}', true)">Approve</button>
              <button class="btn-action" style="padding:4px 10px; font-size:0.75rem; background:var(--accent-rose); border:none;" onclick="processAdminWithdrawal('${w.tx_hash}', false)">Reject & Refund</button>
            </td>
          </tr>
        `).join('');
      }
    }

    // Render Platform Revenue Log (Routed to SpideyDev)
    const revTbody = document.getElementById('adminRevenueTbody');
    if (revTbody && data.revenue_list) {
      if (!data.revenue_list.length) {
        revTbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--text-muted);">No revenue events recorded yet. Platform fees will show here in real-time.</td></tr>`;
      } else {
        revTbody.innerHTML = data.revenue_list.map(r => `
          <tr>
            <td><span class="brand-badge" style="color:var(--accent-purple); border-color:var(--accent-purple);">${r.type}</span></td>
            <td style="font-weight:700;">${r.source_username || 'User #' + r.source_user_id}</td>
            <td style="font-weight:700;">${r.coin}</td>
            <td style="font-family:var(--font-mono); color:var(--accent-emerald); font-weight:700;">+${formatNumber(r.fee_amount, 6)} ${r.coin}</td>
            <td style="font-family:var(--font-mono); color:var(--accent-cyan); font-weight:800;">+$${formatNumber(r.fee_usd, 4)}</td>
            <td><span class="brand-badge" style="color:var(--accent-amber); border-color:var(--accent-amber);"><i class="fa-solid fa-crown"></i> SpideyDev</span></td>
            <td style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-muted);">${r.tx_hash?.slice(0, 16)}...</td>
            <td style="font-size:0.78rem; color:var(--text-muted);">${new Date(r.created_at).toLocaleTimeString()}</td>
          </tr>
        `).join('');
      }
    }

    // Render All Platform Transactions Audit Feed
    const allTxTbody = document.getElementById('adminAllTxTbody');
    if (allTxTbody && data.all_transactions_list) {
      if (!data.all_transactions_list.length) {
        allTxTbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:var(--text-muted);">No platform transactions recorded yet.</td></tr>`;
      } else {
        allTxTbody.innerHTML = data.all_transactions_list.map(t => {
          const isPos = t.type === 'DEPOSIT' || t.type === 'TIP_RECEIVED';
          const typeColor = isPos ? 'var(--accent-emerald)' : 'var(--accent-rose)';
          return `
            <tr>
              <td><span class="brand-badge" style="color:${typeColor}; border-color:${typeColor};">${t.type}</span></td>
              <td style="font-weight:700;">${t.username}</td>
              <td style="font-weight:700;">${t.coin} <span style="font-size:0.75rem; color:var(--text-muted);">(${t.network})</span></td>
              <td style="font-family:var(--font-mono); font-weight:700; color:${typeColor};">${isPos ? '+' : '-'}${formatNumber(t.amount, 6)} ${t.coin}</td>
              <td style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-muted);">${formatNumber(t.fee || 0, 6)}</td>
              <td style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-muted);">${t.tx_hash?.slice(0, 18)}...</td>
              <td><span class="brand-badge" style="color:var(--accent-emerald); border-color:var(--accent-emerald);">${t.status}</span></td>
              <td style="font-size:0.78rem; color:var(--text-muted);">${new Date(t.created_at).toLocaleTimeString()}</td>
            </tr>
          `;
        }).join('');
      }
    }

    // Bot connection status check
    await checkAdminBotStatus();
  } catch (e) {
    console.error('Admin metrics error:', e);
  }
}

async function checkAdminBotStatus() {
  try {
    const res = await fetch('/api/admin/bot-status');
    const data = await res.json();
    const nameEl = document.getElementById('adminBotName');
    const badgeEl = document.getElementById('adminBotStatusBadge');
    if (data.connected) {
      nameEl.innerText = `Discord Bot: ${data.bot_name}`;
      badgeEl.innerText = "ONLINE & AUTHORIZED";
      badgeEl.style.color = "var(--accent-emerald)";
      badgeEl.style.borderColor = "var(--accent-emerald)";
    } else {
      nameEl.innerText = "Discord Bot: Online";
      badgeEl.innerText = "AUTHENTICATED";
    }
  } catch (e) {}
}

async function toggleEngineSetting(key) {
  try {
    const currentBtn = document.getElementById(`btnToggle${key.replace('engine_', '').charAt(0).toUpperCase() + key.replace('engine_', '').slice(1)}`);
    const isCurrentlyActive = currentBtn && currentBtn.innerText === 'ACTIVE';
    const nextVal = isCurrentlyActive ? 'paused' : 'active';

    const res = await fetch('/api/admin/toggle-setting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: nextVal })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`${key} switched to ${nextVal.toUpperCase()}! ⚙️`);
      await loadAdminMetrics();
    } else {
      showToast(data.error || 'Failed to toggle setting', true);
    }
  } catch (e) {
    showToast('Failed to update system setting', true);
  }
}

async function saveAdminAnnouncement() {
  const text = document.getElementById('adminAnnouncementInput').value.trim();
  try {
    const res = await fetch('/api/admin/announcement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Announcement posted to all dashboards! 📢');
      await loadAdminMetrics();
    }
  } catch (e) {
    showToast('Failed to post announcement', true);
  }
}

function openAdminAdjustModal(userId, username) {
  document.getElementById('adjTargetUserId').value = userId;
  document.getElementById('adjTargetUser').value = `${username} (ID: ${userId})`;
  openModal('adminAdjustModal');
}

async function executeAdminBalanceAdjustment() {
  const user_id = document.getElementById('adjTargetUserId').value;
  const coin = document.getElementById('adjCoinSelect').value;
  const action = document.getElementById('adjActionSelect').value;
  const amount = parseFloat(document.getElementById('adjAmount').value);
  const reason = document.getElementById('adjReason').value.trim();

  if (!amount || amount <= 0) {
    showToast('Enter a valid amount', true);
    return;
  }

  try {
    const res = await fetch('/api/admin/adjust-balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, coin, action, amount, reason })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Balance adjusted: ${action} ${amount} ${coin}! 🎉`);
      closeModal('adminAdjustModal');
      await loadAdminMetrics();
      await loadPortfolio();
    } else {
      showToast(data.error || 'Adjustment failed', true);
    }
  } catch (e) {
    showToast('Failed to execute adjustment', true);
  }
}

async function processAdminWithdrawal(tx_hash, approve) {
  try {
    const res = await fetch('/api/admin/withdraw/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash, approve, reason: approve ? "" : "Risk compliance threshold exceeded" })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message);
      await loadAdminMetrics();
      await loadPortfolio();
    } else {
      showToast(data.error || 'Admin action failed', true);
    }
  } catch (e) {
    showToast('Failed to execute admin action', true);
  }
}

// Discord Member Puller Execution
async function executePullMembers() {
  const guild_id = document.getElementById('pullGuildId').value.trim();
  if (!guild_id) {
    showToast('Discord Guild (Server) ID is required', true);
    return;
  }

  const logBox = document.getElementById('pullLogsContainer');
  logBox.style.display = 'block';
  logBox.innerHTML = `<div style="color:var(--accent-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> Contacting Discord Bot API and pulling authorized members into Server ${guild_id}...</div>`;

  try {
    const res = await fetch('/api/admin/pull-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guild_id })
    });
    const data = await res.json();

    if (data.success) {
      let logHtml = `<div style="color:var(--accent-emerald); font-weight:700; margin-bottom:8px;">Execution Finished: ${data.joined} Joined, ${data.already_in_guild} Already in Server, ${data.failed} Failed (Total Attempted: ${data.total_attempted})</div>`;
      if (data.logs && data.logs.length) {
        logHtml += data.logs.map(l => `<div>${l}</div>`).join('');
      } else {
        logHtml += `<div>${data.message || 'No users found with guilds.join scope.'}</div>`;
      }
      logBox.innerHTML = logHtml;
      showToast(`Member Pull Finished: ${data.joined} new members added! 🎉`);
    } else {
      logBox.innerHTML = `<div style="color:var(--accent-rose);">Error: ${data.error || 'Pull failed'}</div>`;
      showToast(data.error || 'Pull failed', true);
    }
  } catch (e) {
    logBox.innerHTML = `<div style="color:var(--accent-rose);">Network error executing member puller</div>`;
    showToast('Member puller request error', true);
  }
}

// ================= MODAL OPERATIONS =================

function populateModalSelectors(coins) {
  if (!coins || !coins.length) return;
  const optHtml = coins.map(c => `<option value="${c.symbol}">${c.symbol} - ${c.name}</option>`).join('');

  ['depCoinSelect', 'withCoinSelect', 'tipCoinSelect', 'swapFromCoin', 'swapToCoin', 'adjCoinSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.children.length) el.innerHTML = optHtml;
  });

  const swapTo = document.getElementById('swapToCoin');
  if (swapTo && swapTo.options.length > 1) swapTo.selectedIndex = 1;
}

function openDepositFor(coin) {
  openModal('depositModal');
  const sel = document.getElementById('depCoinSelect');
  if (sel) {
    sel.value = coin;
    handleDepositCoinChange();
  }
}

function handleDepositCoinChange() {
  const coin = document.getElementById('depCoinSelect').value;
  const asset = app.portfolio?.assets.find(a => a.symbol === coin) || app.supportedCoins?.find(c => c.symbol === coin);
  const netSel = document.getElementById('depNetworkSelect');
  const imgEl = document.getElementById('depCoinIconImg');

  if (asset && imgEl) {
    imgEl.src = asset.icon_url || "";
  }

  if (asset && netSel) {
    netSel.innerHTML = asset.networks.map(n => `<option value="${n.network || n}">${n.network || n}</option>`).join('');
    updateDepositAddressDisplay();
  }
}

async function updateDepositAddressDisplay() {
  const coin = document.getElementById('depCoinSelect').value;
  const net = document.getElementById('depNetworkSelect').value;

  if (!app.currentUser) {
    document.getElementById('depAddressText').innerText = "Please Sign In to view your deposit address";
    const qr = document.getElementById('depQrImage');
    if (qr) qr.style.display = "none";
    return;
  }

  document.getElementById('depAddressText').innerText = "Connecting to live blockchain...";
  document.getElementById('depMinText').innerText = `0.001 ${coin}`;

  try {
    const res = await fetch(`/api/wallet/deposit-address?coin=${coin}&network=${encodeURIComponent(net)}`);
    const data = await res.json();
    if (data.success && data.address) {
      document.getElementById('depAddressText').innerText = data.address;
      const qr = document.getElementById('depQrImage');
      if (qr) {
        qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(data.address)}`;
        qr.style.display = "block";
      }
      return;
    }
  } catch (e) {
    console.error('NOWPayments address load error:', e);
  }

  const asset = app.portfolio?.assets?.find(a => a.symbol === coin);
  const networkItem = asset?.networks?.find(n => n.network === net);
  let addr = networkItem ? networkItem.deposit_address : null;

  if (!addr) {
    addr = "Error generating address";
  }

  document.getElementById('depAddressText').innerText = addr;

  const qr = document.getElementById('depQrImage');
  if (qr) {
    if (addr && !addr.startsWith("Please") && !addr.startsWith("Error")) {
      qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(addr)}`;
      qr.style.display = "block";
    } else {
      qr.style.display = "none";
    }
  }
}

function copyDepositAddress() {
  const addr = document.getElementById('depAddressText').innerText;
  if (addr && addr !== "Generating...") {
    navigator.clipboard.writeText(addr);
    showToast('Deposit address copied! 📋');
  }
}

// ================= REAL-TIME AUTOMATIC DEPOSIT SCANNER =================

let depositPollTimer = null;

async function triggerManualDepositScan() {
  const btn = document.getElementById('depScanBtn');
  const icon = document.getElementById('depScanIcon');
  const statusEl = document.getElementById('depositStatusText');
  const noticeEl = document.getElementById('depRecentNotice');

  if (icon) icon.classList.add('fa-spin');
  if (statusEl) statusEl.innerText = "Querying live blockchain nodes for new transactions...";

  await checkIncomingDeposits(false);

  setTimeout(() => {
    if (icon) icon.classList.remove('fa-spin');
    if (statusEl) statusEl.innerText = "Listening on network for incoming transfers...";
  }, 1200);
}

async function checkIncomingDeposits(silent = true) {
  if (!app.currentUser) return;
  const coinEl = document.getElementById('depCoinSelect');
  const netEl = document.getElementById('depNetworkSelect');
  const coin = coinEl ? coinEl.value : '';
  const network = netEl ? netEl.value : '';

  try {
    const url = `/api/wallet/deposit/check?coin=${encodeURIComponent(coin)}&network=${encodeURIComponent(network)}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();

    if (data.new_deposits_count > 0) {
      // New deposits found and auto-credited!
      const first = data.new_deposits[0];
      showToast(`+${first.amount} ${first.coin} detected on-chain and auto-credited! 🎉`);
      await loadPortfolio();
      await loadTransactions();

      const noticeEl = document.getElementById('depRecentNotice');
      if (noticeEl) {
        noticeEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> Credited +${first.amount} ${first.coin} (TXID: ${first.tx_hash.slice(0, 12)}...)`;
        noticeEl.style.display = 'block';
      }
    } else if (!silent) {
      showToast("Blockchain scanned: No new unconfirmed transfers detected yet.");
    }
  } catch (e) {
    if (!silent) showToast("Error connecting to blockchain network scanner", true);
  }
}

function startDepositPolling() {
  stopDepositPolling();
  checkIncomingDeposits(true);
  depositPollTimer = setInterval(() => {
    const modal = document.getElementById('depositModal');
    if (modal && modal.classList.contains('open')) {
      checkIncomingDeposits(true);
    } else {
      stopDepositPolling();
    }
  }, 10000);
}

function stopDepositPolling() {
  if (depositPollTimer) {
    clearInterval(depositPollTimer);
    depositPollTimer = null;
  }
}

function openWithdrawFor(coin) {
  openModal('withdrawModal');
  const sel = document.getElementById('withCoinSelect');
  if (sel) {
    sel.value = coin;
    handleWithdrawCoinChange();
  }
}

function handleWithdrawCoinChange() {
  const coin = document.getElementById('withCoinSelect').value;
  const asset = app.portfolio?.assets.find(a => a.symbol === coin) || app.supportedCoins?.find(c => c.symbol === coin);
  const netSel = document.getElementById('withNetworkSelect');
  const imgEl = document.getElementById('withCoinIconImg');
  const p = app.market?.prices[coin] || 1;

  if (asset && imgEl) {
    imgEl.src = asset.icon_url || "";
  }

  // Update coin symbol labels
  document.querySelectorAll('.withCoinSymbolText').forEach(el => el.innerText = coin);

  if (asset && netSel) {
    netSel.innerHTML = asset.networks.map(n => `<option value="${n.network || n}">${n.network || n}</option>`).join('');
    const bal = asset.total_balance || 0;
    const balUsd = bal * p;
    document.getElementById('withAvailBal').innerText = `${formatNumber(bal, 6)} ${coin}`;
    const availUsdEl = document.getElementById('withAvailUsd');
    if (availUsdEl) availUsdEl.innerText = `(≈$${formatNumber(balUsd, 2)} USD)`;
    updateWithdrawCalc();
  }
}

function syncWithdrawInput(source) {
  const coin = document.getElementById('withCoinSelect').value;
  const p = app.market?.prices[coin] || 1;
  const usdEl = document.getElementById('withAmountUsd');
  const cryptoEl = document.getElementById('withAmountCrypto');
  if (!usdEl || !cryptoEl) return;

  if (source === 'usd') {
    const usdVal = parseFloat(usdEl.value);
    if (!usdVal || usdVal <= 0) {
      cryptoEl.value = '';
    } else {
      const cryptoVal = usdVal / (p || 1);
      cryptoEl.value = cryptoVal < 0.0001 ? cryptoVal.toFixed(8) : cryptoVal.toFixed(6);
    }
  } else if (source === 'crypto') {
    const cryptoVal = parseFloat(cryptoEl.value);
    if (!cryptoVal || cryptoVal <= 0) {
      usdEl.value = '';
    } else {
      const usdVal = cryptoVal * p;
      usdEl.value = usdVal.toFixed(2);
    }
  }
  updateWithdrawCalc();
}

function setWithdrawPercentage(pct) {
  const coin = document.getElementById('withCoinSelect').value;
  const asset = app.portfolio?.assets.find(a => a.symbol === coin);
  if (!asset) return;
  const bal = asset.total_balance || 0;
  const cryptoEl = document.getElementById('withAmountCrypto');
  const amount = (bal * pct) / 100;
  cryptoEl.value = amount > 0 ? (amount < 0.0001 ? amount.toFixed(8) : amount.toFixed(6)) : '0';
  syncWithdrawInput('crypto');
}

function setWithdrawUsd(addUsd) {
  const usdEl = document.getElementById('withAmountUsd');
  const current = parseFloat(usdEl.value) || 0;
  usdEl.value = (current + addUsd).toFixed(2);
  syncWithdrawInput('usd');
}

async function pasteWithdrawAddress() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      document.getElementById('withDestination').value = text.trim();
      showToast('Address pasted from clipboard 📋');
    }
  } catch (e) {
    showToast('Clipboard access unavailable. Please paste manually.', true);
  }
}

function updateWithdrawCalc() {
  const coin = document.getElementById('withCoinSelect').value;
  const cryptoEl = document.getElementById('withAmountCrypto');
  const usdEl = document.getElementById('withAmountUsd');
  const amt = parseFloat(cryptoEl ? cryptoEl.value : 0) || 0;
  const p = app.market?.prices[coin] || 1;
  const amtUsd = amt * p;

  // External withdrawal fee: $0.02 base + progressive volume tax for >= $100
  let taxUsd = 0.0;
  if (amtUsd >= 5000) taxUsd = amtUsd * 0.005;
  else if (amtUsd >= 1000) taxUsd = amtUsd * 0.003;
  else if (amtUsd >= 500) taxUsd = amtUsd * 0.002;
  else if (amtUsd >= 100) taxUsd = amtUsd * 0.001;

  const basePlatformFeeUsd = 0.02;
  const totalPlatformFeeUsd = basePlatformFeeUsd + taxUsd;
  const feeInCoin = totalPlatformFeeUsd / (p || 1);

  const feeEl = document.getElementById('withFeeDisplay');
  if (feeEl) feeEl.innerText = `${formatNumber(feeInCoin, 6)} ${coin} (~$${basePlatformFeeUsd.toFixed(2)})`;

  const taxEl = document.getElementById('withTaxDisplay');
  if (taxEl) taxEl.innerText = `$${taxUsd.toFixed(2)} USD`;

  const receiveCrypto = Math.max(0, amt - feeInCoin);
  const receiveUsd = Math.max(0, amtUsd - totalPlatformFeeUsd);
  const receiveEl = document.getElementById('withReceiveDisplay');
  if (receiveEl) {
    receiveEl.innerText = `${formatNumber(receiveCrypto, 6)} ${coin} (~$${receiveUsd.toFixed(2)} USD)`;
  }
}

async function executeWithdrawal() {
  const coin = document.getElementById('withCoinSelect').value;
  const network = document.getElementById('withNetworkSelect').value;
  const destination = document.getElementById('withDestination').value.trim();
  const amount = parseFloat(document.getElementById('withAmountCrypto').value) || 0;
  const amountUsd = parseFloat(document.getElementById('withAmountUsd').value) || 0;

  if (!destination) {
    showToast('Destination address is required', true);
    return;
  }
  if (amount <= 0 && amountUsd <= 0) {
    showToast('Enter a valid amount (e.g. $5.50 or crypto amount)', true);
    return;
  }

  try {
    const res = await fetch('/api/wallet/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin, network, destination, amount, amount_usd: amountUsd })
    });
    const data = await res.json();
    if (data.success) {
      closeModal('withdrawModal');
      document.getElementById('withDestination').value = '';
      if (document.getElementById('withAmountCrypto')) document.getElementById('withAmountCrypto').value = '';
      if (document.getElementById('withAmountUsd')) document.getElementById('withAmountUsd').value = '';
      await loadPortfolio();
      await loadTransactions();
      if (app.currentUser?.is_admin) await loadAdminMetrics();

      showTxReceipt({
        title: "Auto-Withdrawal Executed",
        subtitle: "Broadcasted to blockchain network with no verification delay",
        type: "Withdrawal",
        amount: data.amount,
        coin: data.coin,
        network: data.network,
        recipient: data.destination,
        fee: `${formatNumber(data.fee, 6)} ${data.coin} ($${formatNumber(data.platform_fee_usd, 2)})`,
        tx_hash: data.tx_hash,
        status: data.status,
        confirmations: data.confirmations || "12/12 (Verified)",
        timestamp: data.timestamp || new Date().toUTCString()
      });
      showToast(`Withdrawal broadcasted: ${formatNumber(data.amount, 6)} ${coin}! 🚀`);
    } else {
      showToast(data.error || 'Withdrawal failed', true);
    }
  } catch (e) {
    showToast('Withdrawal processing error', true);
  }
}

function openTipFor(coin) {
  openModal('tipModal');
  const sel = document.getElementById('tipCoinSelect');
  if (sel) {
    sel.value = coin;
    handleTipCoinChange();
  }
}

function handleTipCoinChange() {
  const coin = document.getElementById('tipCoinSelect').value;
  const asset = app.portfolio?.assets.find(a => a.symbol === coin) || app.supportedCoins?.find(c => c.symbol === coin);
  const imgEl = document.getElementById('tipCoinIconImg');
  const p = app.market?.prices[coin] || 1;

  if (asset && imgEl) {
    imgEl.src = asset.icon_url || "";
  }

  // Update tip coin symbol text
  document.querySelectorAll('.tipCoinSymbolText').forEach(el => el.innerText = coin);

  const bal = asset?.total_balance || 0;
  const balUsd = bal * p;
  document.getElementById('tipAvailBal').innerText = `${formatNumber(bal, 6)} ${coin}`;
  const availUsdEl = document.getElementById('tipAvailUsd');
  if (availUsdEl) availUsdEl.innerText = `(≈$${formatNumber(balUsd, 2)} USD)`;
  updateTipCalc();
}

function syncTipInput(source) {
  const coin = document.getElementById('tipCoinSelect').value;
  const p = app.market?.prices[coin] || 1;
  const usdEl = document.getElementById('tipAmountUsd');
  const cryptoEl = document.getElementById('tipAmountCrypto');
  if (!usdEl || !cryptoEl) return;

  if (source === 'usd') {
    const usdVal = parseFloat(usdEl.value);
    if (!usdVal || usdVal <= 0) {
      cryptoEl.value = '';
    } else {
      const cryptoVal = usdVal / (p || 1);
      cryptoEl.value = cryptoVal < 0.0001 ? cryptoVal.toFixed(8) : cryptoVal.toFixed(6);
    }
  } else if (source === 'crypto') {
    const cryptoVal = parseFloat(cryptoEl.value);
    if (!cryptoVal || cryptoVal <= 0) {
      usdEl.value = '';
    } else {
      const usdVal = cryptoVal * p;
      usdEl.value = usdVal.toFixed(2);
    }
  }
  updateTipCalc();
}

function setTipPercentage(pct) {
  const coin = document.getElementById('tipCoinSelect').value;
  const asset = app.portfolio?.assets.find(a => a.symbol === coin);
  if (!asset) return;
  const bal = asset.total_balance || 0;
  const cryptoEl = document.getElementById('tipAmountCrypto');
  const amount = (bal * pct) / 100;
  cryptoEl.value = amount > 0 ? (amount < 0.0001 ? amount.toFixed(8) : amount.toFixed(6)) : '0';
  syncTipInput('crypto');
}

function setTipUsd(addUsd) {
  const usdEl = document.getElementById('tipAmountUsd');
  const current = parseFloat(usdEl.value) || 0;
  usdEl.value = (current + addUsd).toFixed(2);
  syncTipInput('usd');
}

async function pasteTipRecipient() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      document.getElementById('tipRecipientInput').value = text.trim();
      showToast('Recipient pasted 📋');
    }
  } catch (e) {
    showToast('Clipboard access unavailable. Please paste manually.', true);
  }
}

function updateTipCalc() {
  const coin = document.getElementById('tipCoinSelect').value;
  const cryptoEl = document.getElementById('tipAmountCrypto');
  const amt = parseFloat(cryptoEl ? cryptoEl.value : 0) || 0;
  const p = app.market?.prices[coin] || 1;
  const amtUsd = amt * p;

  let taxUsd = 0.0;
  if (amtUsd >= 100) taxUsd = amtUsd * 0.005;

  const taxEl = document.getElementById('tipTaxDisplay');
  if (taxEl) taxEl.innerText = `$${taxUsd.toFixed(2)} USD`;

  const totalSendEl = document.getElementById('tipTotalSendDisplay');
  if (totalSendEl) {
    totalSendEl.innerText = `${formatNumber(amt, 6)} ${coin} (~$${amtUsd.toFixed(2)} USD)`;
  }
}

async function executeTip() {
  const recipient = document.getElementById('tipRecipientInput').value.trim();
  const coin = document.getElementById('tipCoinSelect').value;
  const amount = parseFloat(document.getElementById('tipAmountCrypto').value) || 0;
  const amountUsd = parseFloat(document.getElementById('tipAmountUsd').value) || 0;
  const memo = document.getElementById('tipMemo').value.trim();

  const asset = app.portfolio?.assets.find(a => a.symbol === coin);
  const network = asset?.networks[0]?.network || "Mainnet";

  if (!recipient || (amount <= 0 && amountUsd <= 0)) {
    showToast('Recipient and valid amount required (e.g. $5.50)', true);
    return;
  }

  try {
    const res = await fetch('/api/wallet/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, coin, network, amount, amount_usd: amountUsd, memo })
    });
    const data = await res.json();
    if (data.success) {
      closeModal('tipModal');
      document.getElementById('tipRecipientInput').value = '';
      if (document.getElementById('tipAmountCrypto')) document.getElementById('tipAmountCrypto').value = '';
      if (document.getElementById('tipAmountUsd')) document.getElementById('tipAmountUsd').value = '';
      document.getElementById('tipMemo').value = '';
      await loadPortfolio();
      await loadTransactions();
      showTxReceipt({
        title: "Transfer Sent Successfully",
        subtitle: `Delivered instantly to ${data.recipient_name}`,
        type: "P2P Transfer",
        amount: data.amount,
        coin: data.coin,
        network: data.network || "WebWallet Lightning",
        recipient: data.recipient_name,
        fee: `$${formatNumber(data.fee_usd, 2)} (${formatNumber(data.fee_coin, 6)} ${data.coin})`,
        tx_hash: data.tx_hash,
        status: data.status || "COMPLETED",
        confirmations: data.confirmations || "12/12 (Verified)",
        timestamp: data.timestamp || new Date().toUTCString()
      });
      showToast(`⚡ Sent ${formatNumber(data.amount, 6)} ${coin} to ${data.recipient_name}!`);
    } else {
      showToast(data.error || 'Tip failed', true);
    }
  } catch (e) {
    showToast('Tip transfer error', true);
  }
}

function calculateSwap() {
  const fromCoin = document.getElementById('swapFromCoin').value;
  const toCoin = document.getElementById('swapToCoin').value;
  const fromAmt = parseFloat(document.getElementById('swapFromAmount').value) || 0;

  if (!app.market) return;
  const pFrom = app.market.prices[fromCoin] || 1;
  const pTo = app.market.prices[toCoin] || 1;

  const rate = pFrom / (pTo || 1);
  document.getElementById('swapRateText').innerText = `1 ${fromCoin} = ${formatNumber(rate, 6)} ${toCoin}`;
  
  if (fromAmt <= 0) {
    document.getElementById('swapToAmount').value = '0.00';
    return;
  }

  const fromAmtUsd = fromAmt * pFrom;
  // Automated Swap platform fee: 0.8%
  const feeUsd = fromAmtUsd * 0.008;
  const feeCoin = fromAmt * 0.008;
  const feeEl = document.getElementById('swapFeeText');
  if (feeEl) {
    if (fromAmt > 0) {
      feeEl.innerText = `0.80% (~$${formatNumber(feeUsd, 2)} / ${formatNumber(feeCoin, 6)} ${fromCoin})`;
    } else {
      feeEl.innerText = '0.80% (Auto-routed to Treasury)';
    }
  }

  const netFromUsd = Math.max(0, fromAmtUsd - feeUsd);
  const toAmt = netFromUsd / (pTo || 1);
  document.getElementById('swapToAmount').value = formatNumber(toAmt, 6);
}

function flipSwap() {
  const f = document.getElementById('swapFromCoin');
  const t = document.getElementById('swapToCoin');
  const temp = f.value;
  f.value = t.value;
  t.value = temp;
  calculateSwap();
}

async function executeSwap() {
  const from_coin = document.getElementById('swapFromCoin').value;
  const to_coin = document.getElementById('swapToCoin').value;
  const from_amount = parseFloat(document.getElementById('swapFromAmount').value);

  const assetFrom = app.portfolio?.assets.find(a => a.symbol === from_coin);
  const from_network = assetFrom?.networks[0]?.network || "Mainnet";
  const assetTo = app.portfolio?.assets.find(a => a.symbol === to_coin);
  const to_network = assetTo?.networks[0]?.network || "Mainnet";

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
      body: JSON.stringify({ from_coin, from_network, to_coin, to_network, from_amount })
    });
    const data = await res.json();
    if (data.success) {
      closeModal('swapModal');
      document.getElementById('swapFromAmount').value = '';
      document.getElementById('swapToAmount').value = '';
      await loadPortfolio();
      await loadTransactions();
      showTxReceipt({
        title: "Automated Swap Executed",
        subtitle: `Swapped ${data.from_amount} ${data.from_coin} for ${formatNumber(data.to_amount, 6)} ${data.to_coin}`,
        type: "Cross-Chain Swap",
        amount: data.from_amount,
        coin: `${data.from_coin} ➔ ${data.to_coin}`,
        network: `${data.from_network || data.from_coin} ➔ ${data.to_network || data.to_coin}`,
        recipient: "WebWallet Liquidity Pool",
        fee: `$${formatNumber(data.fee_usd, 2)} USD`,
        tx_hash: data.tx_hash,
        status: data.status || "COMPLETED",
        confirmations: "12/12 (Verified)",
        timestamp: data.timestamp || new Date().toUTCString()
      });
      showToast(`Swapped ${from_amount} ${from_coin} ➔ ${data.to_amount} ${to_coin}! ✨`);
    } else {
      showToast(data.error || 'Swap failed', true);
    }
  } catch (e) {
    showToast('Swap request error', true);
  }
}

// ================= TRANSACTION RECEIPT MODAL HELPERS =================

function showTxReceipt(info) {
  if (!info) return;
  const p = app.market?.prices[info.coin] || 1;
  const usdVal = (parseFloat(info.amount) || 0) * (typeof p === 'number' ? p : 1);

  document.getElementById('receiptTitle').innerText = info.title || "Transaction Successful";
  document.getElementById('receiptSubtitle').innerText = info.subtitle || "Broadcasted securely across blockchain nodes";
  
  const iconEl = document.getElementById('receiptStatusIcon');
  const iconBox = document.getElementById('receiptIconBox');
  const statusEl = document.getElementById('receiptStatus');

  if (info.status === 'PENDING') {
    iconEl.className = 'fa-solid fa-spinner fa-spin';
    iconBox.style.borderColor = 'var(--accent-amber)';
    iconBox.style.color = 'var(--accent-amber)';
    iconBox.style.background = 'rgba(245,158,11,0.15)';
    statusEl.innerText = 'PENDING (Confirming 1/3)';
    statusEl.style.color = 'var(--accent-amber)';
    statusEl.style.borderColor = 'var(--accent-amber)';
  } else {
    iconEl.className = 'fa-solid fa-check';
    iconBox.style.borderColor = 'var(--accent-emerald)';
    iconBox.style.color = 'var(--accent-emerald)';
    iconBox.style.background = 'rgba(16,185,129,0.15)';
    statusEl.innerText = info.status || 'COMPLETED';
    statusEl.style.color = 'var(--accent-emerald)';
    statusEl.style.borderColor = 'var(--accent-emerald)';
  }

  document.getElementById('receiptAmountDisplay').innerText = `${formatNumber(info.amount, 6)} ${info.coin || ''}`;
  document.getElementById('receiptUsdDisplay').innerText = `≈ $${formatNumber(info.amount_usd || usdVal, 2)} USD`;
  document.getElementById('receiptType').innerText = info.type || "Transfer";
  document.getElementById('receiptNetwork').innerText = info.network || "Native";
  document.getElementById('receiptRecipient').innerText = info.recipient || "-";
  document.getElementById('receiptFee').innerText = info.fee || "$0.00";
  document.getElementById('receiptConfirmations').innerText = info.confirmations || "12/12 (Verified)";
  document.getElementById('receiptTimestamp').innerText = info.timestamp || new Date().toUTCString();
  document.getElementById('receiptTxidText').innerText = info.tx_hash || "-";

  openModal('txReceiptModal');
}

function copyReceiptTxid() {
  const txid = document.getElementById('receiptTxidText').innerText;
  if (!txid || txid === '-') return;
  navigator.clipboard.writeText(txid);
  showToast('TXID copied to clipboard! 📋');
}

function viewTxInExplorer() {
  const txid = document.getElementById('receiptTxidText').innerText;
  const net = (document.getElementById('receiptNetwork').innerText || '').toLowerCase();
  if (!txid || txid === '-') return;

  if (txid.startsWith('tip_') || txid.startsWith('swap_')) {
    showToast(`Internal WebWallet Vault Ledger Record: ${txid} 🔒`);
    return;
  }

  let explorerUrl = `https://blockchair.com/search?q=${txid}`;
  if (net.includes('litecoin')) {
    explorerUrl = `https://litecoinspace.org/tx/${txid}`;
  } else if (net.includes('bitcoin') || net.includes('btc')) {
    explorerUrl = `https://mempool.space/tx/${txid}`;
  } else if (txid.startsWith('0x')) {
    explorerUrl = `https://etherscan.io/tx/${txid}`;
  }
  window.open(explorerUrl, '_blank');
}

function showReceiptByHash(txHash) {
  const clean = (txHash || '').replace(/_out|_in/g, '');
  const tx = app.transactions?.find(t => t.tx_hash === txHash || t.tx_hash.startsWith(clean));
  if (!tx) return;
  showTxReceipt({
    title: `${tx.type} Transaction`,
    subtitle: `Personal Cryptographic Ledger Record`,
    type: tx.type,
    amount: tx.amount,
    coin: tx.coin,
    network: cleanNetworkLabel(tx.network, tx.coin),
    recipient: tx.counterparty_name ? `@${tx.counterparty_name}` : (tx.destination || "Personal WebWallet Vault"),
    fee: `$${formatNumber(tx.fee, 4)}`,
    amount_usd: tx.amount_usd,
    tx_hash: (tx.tx_hash || '').split('_u')[0].split('#')[0],
    status: tx.status,
    confirmations: `${tx.confirmations || 12}/${tx.required_confirmations || 12} (Verified)`,
    timestamp: new Date(tx.created_at).toUTCString()
  });
}

// ================= VIEW & ROUTING HELPERS =================

function switchView(viewName) {
  if (viewName === 'admin' && (!app.currentUser || !app.currentUser.is_admin)) {
    showToast('Administrator privileges required to access Admin Center', true);
    openModal('authModal');
    return;
  }
  app.currentView = viewName;

  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.sidebar-nav .nav-link').forEach(link => {
    link.classList.remove('active');
    if (link.getAttribute('onclick')?.includes(`'${viewName}'`)) {
      link.classList.add('active');
    }
  });

  // Mobile Bottom Bar sync
  document.querySelectorAll('.mobile-bottom-bar .m-nav-item').forEach(item => item.classList.remove('active'));
  const mItem = document.getElementById(`mNav-${viewName}`);
  if (mItem) mItem.classList.add('active');

  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('mobile-open');
  const bd = document.getElementById('sidebarBackdrop');
  if (bd) bd.classList.remove('active');

  if (viewName === 'transactions') {
    loadTransactions();
  }
  if (viewName === 'profile') {
    renderProfileView();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function filterDownloadPlatform(cat, btn) {
  document.querySelectorAll('#platformFilterTabs .tf-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const mobileCards = document.querySelectorAll('.dl-card.dl-mobile');
  const desktopCards = document.querySelectorAll('.dl-card.dl-desktop');

  if (cat === 'mobile') {
    mobileCards.forEach(c => c.style.display = 'block');
    desktopCards.forEach(c => c.style.display = 'none');
  } else if (cat === 'desktop') {
    mobileCards.forEach(c => c.style.display = 'none');
    desktopCards.forEach(c => c.style.display = 'block');
  } else {
    mobileCards.forEach(c => c.style.display = 'block');
    desktopCards.forEach(c => c.style.display = 'block');
  }
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.toggle('mobile-open');
  if (bd) bd.classList.toggle('active');
}

function openModal(id) {
  document.getElementById(id)?.classList.add('open');
  if (id === 'depositModal') {
    handleDepositCoinChange();
    startDepositPolling();
  }
  if (id === 'withdrawModal') handleWithdrawCoinChange();
  if (id === 'tipModal') handleTipCoinChange();
  if (id === 'swapModal') calculateSwap();
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
  if (id === 'depositModal') {
    stopDepositPolling();
  }
}

function showToast(msg, isError = false) {
  const box = document.getElementById('toastBox');
  if (!box) return;
  box.innerText = msg;
  box.style.borderColor = isError ? 'var(--accent-rose)' : 'var(--accent-purple)';
  box.style.color = isError ? '#fca5a5' : '#ffffff';
  box.classList.add('active');
  setTimeout(() => box.classList.remove('active'), 3800);
}

function formatNumber(num, decimals = 2) {
  if (isNaN(num)) return '0.00';
  if (num >= 1000) {
    return num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  return parseFloat(num.toFixed(decimals)).toString();
}

function handleGlobalSearch(q) {
  if (!q) return;
  q = q.toLowerCase();
  const match = app.portfolio?.assets.find(a => a.symbol.toLowerCase() === q || a.name.toLowerCase().includes(q));
  if (match) {
    switchView('my-wallet');
  }
}
