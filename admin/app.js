// ── STATE ──────────────────────────────────────────────────────────
const API_BASE = window.location.origin + '/api';
let idToken = null;
let currentPage = 1;
let totalPages = 1;
let searchQuery = '';
let currentUserUid = null;

const firebaseConfig = {
  apiKey: "AIzaSyBLrg5egOOGrd3wyf5IBzPI2m9fHp_AR6k",
  authDomain: "kiduyutvfinal.firebaseapp.com",
  databaseURL: "https://kiduyutvfinal-default-rtdb.firebaseio.com",
  projectId: "kiduyutvfinal",
  storageBucket: "kiduyutvfinal.firebasestorage.app",
  messagingSenderId: "109926033937",
  appId: "1:109926033937:web:1d08a18dadea581ff2dfb0",
  measurementId: "G-W132D0XSLH"
};



// Initialize Firebase Auth
let auth = null;
let initialized = false;
let googleProvider = null;
try {
  if (typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    googleProvider = new firebase.auth.GoogleAuthProvider();
    initialized = true;
  }
} catch (e) {
  console.warn('Firebase not loaded, using manual token entry');
}

// ── DOM REFS ────────────────────────────────────────────────────────
const $loginScreen = document.getElementById('loginScreen');
const $adminScreen = document.getElementById('adminScreen');
const $loginForm = document.getElementById('loginForm');
const $loginBtn = document.getElementById('loginBtn');
const $loginError = document.getElementById('loginError');
const $logoutBtn = document.getElementById('logoutBtn');
const $userName = document.getElementById('userName');
const $userEmail = document.getElementById('userEmail');
const $userAvatar = document.getElementById('userAvatar');
const $currentAdminUid = document.getElementById('currentAdminUid');
const $apiStatus = document.getElementById('apiStatus');

// Toast
const $toastContainer = document.getElementById('toastContainer');

// ── UTILS ───────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function showConfirm(title, message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirmDialog');
    document.getElementById('dialogTitle').textContent = title;
    document.getElementById('dialogMessage').textContent = message;
    dialog.style.display = 'flex';
    document.getElementById('dialogConfirm').onclick = () => {
      dialog.style.display = 'none';
      resolve(true);
    };
    document.getElementById('dialogCancel').onclick = () => {
      dialog.style.display = 'none';
      resolve(false);
    };
  });
}

function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'Just now';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getPosterUrl(path, size = 'w185') {
  if (!path) return '';
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

// ── API CALLS ───────────────────────────────────────────────────────
async function apiCall(method, endpoint, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── AUTH ───────────────────────────────────────────────────────────
async function handleLogin(email, password) {
  if (!initialized) {
    // Fallback: manual token entry - user enters their ID token directly
    // For demo, we'll show a token input prompt
    showToast('Enter your Firebase ID token in the email field as a workaround', 'error');
    return;
  }

  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    idToken = await cred.user.getIdToken();
    showAdminScreen();
  } catch (err) {
    $loginError.textContent = err.message;
    $loginError.style.display = 'block';
    $loginBtn.disabled = false;
    $loginBtn.innerHTML = '<span class="btn-text">Sign In</span>';
  }
}

async function handleGoogleLogin() {
  if (!initialized || !googleProvider) {
    showToast('Google sign-in is not available. Make sure Firebase is loaded.', 'error');
    return;
  }

  const $googleBtn = document.getElementById('googleLoginBtn');
  $googleBtn.disabled = true;
  $googleBtn.textContent = 'Signing in...';
  $loginError.style.display = 'none';

  try {
    const result = await auth.signInWithPopup(googleProvider);
    idToken = await result.user.getIdToken();

    // Verify this user is an admin in Firestore
    const verifyRes = await fetch(`${API_BASE}/api/admin/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || !verifyData.success) {
      await auth.signOut();
      idToken = null;
      $loginError.textContent = verifyData.error || 'You are not authorized as an admin.';
      $loginError.style.display = 'block';
      return;
    }

    showAdminScreen();
  } catch (err) {
    // Don't show error if user just closed the popup
    if (err.code !== 'auth/popup-closed-by-user') {
      $loginError.textContent = err.message;
      $loginError.style.display = 'block';
    }
  } finally {
    $googleBtn.disabled = false;
    $googleBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
      Sign in with Google
    `;
  }
}

async function logout() {
  if (auth) await auth.signOut();
  idToken = null;
  $loginScreen.classList.add('active');
  $adminScreen.classList.remove('active');
  $loginForm.reset();
}

function showAdminScreen() {
  $loginScreen.classList.remove('active');
  $adminScreen.classList.add('active');
  loadDashboard();
}

// ── TAB NAVIGATION ──────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const tab = item.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById(`${tab}Tab`).classList.add('active');
    if (tab === 'analytics') loadAnalytics();
    if (tab === 'currentSettings') loadCurrentSettings();
    if (tab === 'users') loadUsers();
    if (tab === 'settings') {
      checkApiStatus();
      ['streaming', 'api', 'ads', 'filters', 'network', 'features', 'app_packagenames', 'home_dialog'].forEach(loadConfigSection);
      loadProviders();
    }
  });
});

// ── DASHBOARD ───────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const data = await apiCall('GET', `/admin/analytics?idToken=${encodeURIComponent(idToken)}`);

    document.getElementById('statTotalUsers').textContent = data.totalUsers?.toLocaleString() || '0';
    document.getElementById('statUsersWithList').textContent = data.usersWithMyList?.toLocaleString() || '0';
    document.getElementById('statTotalListItems').textContent = data.totalMyListItems?.toLocaleString() || '0';
    document.getElementById('statUsersWithHistory').textContent = data.usersWithWatchHistory?.toLocaleString() || '0';

    // Provider distribution chart
    renderProviderChart(data.providerDistribution || {});
    renderTopChart('topMoviesChart', data.topMyListMovies || [], 'Movies');
    renderTopChart('topTvChart', data.topMyListTvShows || [], 'TV Shows');
    renderTopChart('topCastsChart', data.topSavedCasts || [], 'Casts');

    // Recent users
    const users = await apiCall('GET', `/admin/users?idToken=${encodeURIComponent(idToken)}&limit=5`);
    renderRecentUsers(users.users || []);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderProviderChart(distribution) {
  const container = document.getElementById('providerChart');
  const entries = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0);
  if (entries.length === 0) {
    container.innerHTML = '<div class="chart-loading">No data available</div>';
    return;
  }
  container.innerHTML = entries.slice(0, 8).map(([provider, count]) => {
    const pct = total > 0 ? (count / total * 100).toFixed(1) : 0;
    return `<div class="chart-bar">
      <span class="chart-bar-label">${escapeHtml(provider)}</span>
      <div class="chart-bar-fill-wrap"><div class="chart-bar-fill" style="width:${pct}%"></div></div>
      <span class="chart-bar-count">${count} (${pct}%)</span>
    </div>`;
  }).join('');
}

function renderTopChart(containerId, items, label) {
  const container = document.getElementById(containerId);
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="chart-loading">No data available</div>';
    return;
  }
  const max = items[0]?.count || 1;
  container.innerHTML = items.slice(0, 8).map(item => {
    const pct = (item.count / max * 100).toFixed(0);
    // Prefer the resolved title from the server; fall back to the cast's
    // .name field (topSavedCasts), then to a TMDB id placeholder.
    const name = item.title || item.name || `TMDB #${item.tmdbId}`;
    return `<div class="chart-bar">
      <span class="chart-bar-label" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <div class="chart-bar-fill-wrap"><div class="chart-bar-fill" style="width:${pct}%"></div></div>
      <span class="chart-bar-count">${item.count}</span>
    </div>`;
  }).join('');
}

function renderRecentUsers(users) {
  const container = document.getElementById('recentUsersTable');
  if (!users.length) {
    container.innerHTML = '<div class="table-loading">No users found</div>';
    return;
  }
  container.innerHTML = users.map(user => `
    <div class="table-row">
      <div style="min-width:32px">
        ${user.photoURL ? `<img src="${escapeHtml(user.photoURL)}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover">` : '<div style="width:32px;height:32px;background:#2a2e38;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600">' + (user.displayName?.[0] || 'A') + '</div>'}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:13px">${escapeHtml(user.displayName)}</div>
        <div style="font-size:11px;color:#8a8fa0">${escapeHtml(user.email)}</div>
      </div>
      <div style="font-size:12px;color:#8a8fa0;text-align:right">
        <div>Joined: ${formatDate(user.createdAt)}</div>
        <div>Login: ${formatRelativeTime(user.lastLoginAt)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        <span style="font-size:12px;color:#E50914;font-weight:600">${user.myListCount || 0}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a8fa0" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      </div>
    </div>
  `).join('');
}

// ── USERS TABLE ─────────────────────────────────────────────────────
async function loadUsers(page = 1, search = '') {
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = '<tr><td colspan="10" class="table-loading">Loading...</td></tr>';
  try {
    const res = await apiCall('GET', `/admin/users?idToken=${encodeURIComponent(idToken)}&page=${page}&limit=20&search=${encodeURIComponent(search)}`);
    renderUsersTable(res.users || []);
    currentPage = res.page;
    totalPages = res.totalPages;
    updatePagination();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="table-loading" style="color:#ff4444">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="table-loading">No users found</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(user => `
    <tr>
      <td>
        <div class="user-cell">
          ${user.photoURL ? `<img src="${escapeHtml(user.photoURL)}" alt="">` : '<div style="width:32px;height:32px;background:#2a2e38;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0">' + (user.displayName?.[0] || 'A') + '</div>'}
          <div>
            <div class="user-cell-name">${escapeHtml(user.displayName)}</div>
            <div class="user-cell-uid">${escapeHtml(user.uid?.substring(0, 12))}...</div>
          </div>
        </div>
      </td>
      <td style="color:#8a8fa0;font-size:12px">${escapeHtml(user.email)}</td>
      <td style="font-size:12px;color:#8a8fa0">${formatDate(user.createdAt)}</td>
      <td style="font-size:12px;color:#8a8fa0">${formatRelativeTime(user.lastLoginAt)}</td>
      <td style="text-align:center"><span style="color:#E50914;font-weight:600;font-size:13px">${user.myListCount || 0}</span></td>
      <td style="text-align:center"><span style="color:#8a8fa0;font-size:13px">${user.watchHistoryCount || 0}</span></td>
      <td style="text-align:center"><span style="color:#8a8fa0;font-size:13px">${user.savedChannelsCount || 0}</span></td>
      <td style="text-align:center"><span style="color:#8a8fa0;font-size:13px">${user.savedCastsCount || 0}</span></td>
      <td><span class="provider-badge">${escapeHtml(user.defaultProvider || 'Auto')}</span></td>
      <td><button class="btn-view" onclick="openUserDetail('${user.uid}')">View</button></td>
    </tr>
  `).join('');
}

function updatePagination() {
  document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
  document.getElementById('prevPage').disabled = currentPage <= 1;
  document.getElementById('nextPage').disabled = currentPage >= totalPages;
}

// Pagination buttons
document.getElementById('prevPage').addEventListener('click', () => {
  if (currentPage > 1) loadUsers(currentPage - 1, searchQuery);
});
document.getElementById('nextPage').addEventListener('click', () => {
  if (currentPage < totalPages) loadUsers(currentPage + 1, searchQuery);
});

// Search
const $userSearch = document.getElementById('userSearch');
const $clearSearch = document.getElementById('clearSearch');
let searchTimeout;
$userSearch.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = $userSearch.value;
    $clearSearch.style.display = searchQuery ? 'block' : 'none';
    loadUsers(1, searchQuery);
  }, 400);
});
$clearSearch.addEventListener('click', () => {
  $userSearch.value = '';
  searchQuery = '';
  $clearSearch.style.display = 'none';
  loadUsers(1, '');
});

// Refresh
document.getElementById('refreshUsers').addEventListener('click', () => loadUsers(currentPage, searchQuery));

// ── USER DETAIL MODAL ────────────────────────────────────────────────
async function openUserDetail(uid) {
  currentUserUid = uid;
  const modal = document.getElementById('userDetailModal');
  const content = document.getElementById('detailContent');
  content.innerHTML = '<div class="detail-loading">Loading...</div>';
  modal.classList.add('active');

  try {
    const data = await apiCall('GET', `/admin/users/${uid}?idToken=${encodeURIComponent(idToken)}`);

    // Set user info in header
    if (data.auth) {
      document.getElementById('detailUserName').textContent = data.auth.displayName || 'Anonymous';
      document.getElementById('detailUserEmail').textContent = data.auth.email || '';
      const avatar = document.getElementById('detailAvatar');
      if (data.auth.photoURL) {
        avatar.src = data.auth.photoURL;
        avatar.style.display = 'block';
      } else {
        avatar.style.display = 'none';
      }
    }

    // Show first section (My List)
    renderDetailSection('mylist', data.myList || {});
  } catch (err) {
    content.innerHTML = `<div class="detail-loading" style="color:#ff4444">${escapeHtml(err.message)}</div>`;
  }
}

function renderDetailSection(section, data) {
  const content = document.getElementById('detailContent');
  const counts = {
    mylist: Object.keys(data.myList || {}).length,
    history: Object.keys(data.watchHistory?.movies || data.watchHistory || {}).length,
    channels: Object.keys(data.savedChannels || {}).length,
    casts: Object.keys(data.savedCasts || {}).length,
    companies: Object.keys(data.savedCompanies || {}).length,
    networks: Object.keys(data.savedNetworks || {}).length
  };

  // Update tab labels with counts
  document.querySelectorAll('.detail-tab').forEach(tab => {
    const sec = tab.dataset.section;
    tab.textContent = `${sec.charAt(0).toUpperCase() + sec.slice(1)} (${counts[sec] || 0})`;
  });

  let html = '';
  const entries = Object.entries(data);

  if (section === 'mylist' || section === 'history') {
    const items = section === 'history' ? (data.movies ? Object.entries(data.movies) : Object.entries(data)) : Object.entries(data);
    if (!items.length) {
      html = '<div class="detail-loading">No items</div>';
    } else {
      html = `<div class="media-grid">${items.map(([key, item]) => {
        const title = item.title || item.name || 'Unknown';
        const poster = item.posterPath || '';
        const vote = item.voteAverage || 0;
        const type = item.isTv ? 'TV' : 'Movie';
        return `<div class="media-item">
          ${poster ? `<img src="${getPosterUrl(poster, 'w185')}" alt="${escapeHtml(title)}" loading="lazy">` : '<div style="aspect-ratio:2/3;background:#2a2e38;display:flex;align-items:center;justify-content:center;font-size:12px;color:#8a8fa0">No Image</div>'}
          <div class="media-item-info">
            <div class="media-item-title">${escapeHtml(title)}</div>
            <div class="media-item-meta">⭐ ${vote.toFixed(1)} · <span class="media-item-badge">${type}</span></div>
          </div>
        </div>`;
      }).join('')}</div>`;
    }
  } else if (section === 'channels') {
    if (!entries.length) {
      html = '<div class="detail-loading">No saved channels</div>';
    } else {
      html = entries.map(([key, ch]) => `
        <div class="channel-item">
          ${ch.logo ? `<img src="${escapeHtml(ch.logo)}" alt="">` : '<div style="width:40px;height:40px;background:#2a2e38;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#8a8fa0">TV</div>'}
          <div style="flex:1;min-width:0">
            <div class="channel-item-name">${escapeHtml(ch.name || 'Unknown')}</div>
            <div class="channel-item-group">${escapeHtml(ch.group || '')}</div>
          </div>
        </div>
      `).join('');
    }
  } else if (section === 'casts') {
    if (!entries.length) {
      html = '<div class="detail-loading">No saved casts</div>';
    } else {
      html = entries.map(([key, cast]) => `
        <div class="cast-item">
          ${cast.profilePath ? `<img src="${getPosterUrl(cast.profilePath, 'w185')}" alt="">` : '<div style="width:48px;height:48px;background:#2a2e38;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600">' + (cast.name?.[0] || '?') + '</div>'}
          <div>
            <div class="cast-item-name">${escapeHtml(cast.name || 'Unknown')}</div>
            ${cast.character ? `<div class="cast-item-character">${escapeHtml(cast.character)}</div>` : ''}
            ${cast.knownForDepartment ? `<div style="font-size:11px;color:#8a8fa0;margin-top:2px">${escapeHtml(cast.knownForDepartment)}</div>` : ''}
          </div>
        </div>
      `).join('');
    }
  } else if (section === 'companies' || section === 'networks') {
    if (!entries.length) {
      html = '<div class="detail-loading">No saved items</div>';
    } else {
      html = entries.map(([key, item]) => `
        <div class="channel-item">
          ${item.logoPath ? `<img src="${getPosterUrl(item.logoPath, 'w92')}" alt="" style="width:40px;height:40px;object-fit:contain;background:#1a1d23;border-radius:6px">` : '<div style="width:40px;height:40px;background:#2a2e38;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#8a8fa0">Co</div>'}
          <div style="flex:1;min-width:0">
            <div class="channel-item-name">${escapeHtml(item.name || 'Unknown')}</div>
          </div>
        </div>
      `).join('');
    }
  }

  content.innerHTML = html;
}

// Detail tabs
document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const section = tab.dataset.section;
    if (!currentUserUid) return;
    try {
      const data = await apiCall('GET', `/admin/users/${currentUserUid}?idToken=${encodeURIComponent(idToken)}`);
      let sectionData;
      switch (section) {
        case 'mylist': sectionData = data.myList || {}; break;
        case 'history': sectionData = data.watchHistory || {}; break;
        case 'channels': sectionData = data.savedChannels || {}; break;
        case 'casts': sectionData = data.savedCasts || {}; break;
        case 'companies': sectionData = data.savedCompanies || {}; break;
        case 'networks': sectionData = data.savedNetworks || {}; break;
      }
      renderDetailSection(section, sectionData);
    } catch (err) {
      document.getElementById('detailContent').innerHTML = `<div class="detail-loading" style="color:#ff4444">${escapeHtml(err.message)}</div>`;
    }
  });
});

// Close modal
document.getElementById('closeUserDetail').addEventListener('click', () => {
  document.getElementById('userDetailModal').classList.remove('active');
  currentUserUid = null;
});
document.getElementById('userDetailModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('userDetailModal')) {
    document.getElementById('userDetailModal').classList.remove('active');
    currentUserUid = null;
  }
});

// Delete user data
document.getElementById('deleteUserData').addEventListener('click', async () => {
  if (!currentUserUid) return;
  const confirmed = await showConfirm('Delete User Data', 'This will permanently delete all data for this user from the Realtime Database. This action cannot be undone.');
  if (!confirmed) return;
  try {
    await apiCall('DELETE', `/admin/users/${currentUserUid}/data`, { idToken });
    showToast('User data deleted successfully', 'success');
    document.getElementById('userDetailModal').classList.remove('active');
    loadUsers(currentPage, searchQuery);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── ANALYTICS ───────────────────────────────────────────────────────
async function loadAnalytics() {
  try {
    const data = await apiCall('GET', `/admin/analytics?idToken=${encodeURIComponent(idToken)}`);

    // Provider distribution
    const provContainer = document.getElementById('analyticsProviders');
    const provEntries = Object.entries(data.providerDistribution || {}).sort((a, b) => b[1] - a[1]);
    provContainer.innerHTML = provEntries.length ? provEntries.map(([k, v]) =>
      `<div class="analytics-item"><span class="analytics-item-name">${escapeHtml(k)}</span><span class="analytics-item-count">${v}</span></div>`
    ).join('') : '<div style="color:#8a8fa0;font-size:13px">No data</div>';

    // Top movies
    const moviesContainer = document.getElementById('analyticsTopMovies');
    moviesContainer.innerHTML = (data.topMyListMovies?.length)
      ? data.topMyListMovies.map(m => {
          const name = m.title || `TMDB #${m.tmdbId}`;
          return `<div class="analytics-item" title="${escapeHtml(name)}"><span class="analytics-item-name">${escapeHtml(name)}</span><span class="analytics-item-count">${m.count}</span></div>`;
        }).join('')
      : '<div style="color:#8a8fa0;font-size:13px">No data</div>';

    // Top TV
    const tvContainer = document.getElementById('analyticsTopTv');
    tvContainer.innerHTML = (data.topMyListTvShows?.length)
      ? data.topMyListTvShows.map(t => {
          const name = t.title || `TMDB #${t.tmdbId}`;
          return `<div class="analytics-item" title="${escapeHtml(name)}"><span class="analytics-item-name">${escapeHtml(name)}</span><span class="analytics-item-count">${t.count}</span></div>`;
        }).join('')
      : '<div style="color:#8a8fa0;font-size:13px">No data</div>';

    // Top casts
    const castsContainer = document.getElementById('analyticsTopCasts');
    castsContainer.innerHTML = (data.topSavedCasts?.length)
      ? data.topSavedCasts.map(c => `<div class="analytics-item"><span class="analytics-item-name">${escapeHtml(c.name)}</span><span class="analytics-item-count">${c.count}</span></div>`).join('')
      : '<div style="color:#8a8fa0;font-size:13px">No data</div>';

  } catch (err) {
    showToast(err.message, 'error');
  }
}
document.getElementById('refreshAnalytics').addEventListener('click', loadAnalytics);

// ── CURRENT SETTINGS (read-only snapshot) ────────────────────────
// Fields considered sensitive — values are masked
const MASKED_FIELDS = new Set([
  'tmdb_bearer_token', 'trakt_client_id', 'trakt_client_secret',
  'phone_banner_ad_unit_id', 'phone_interstitial_ad_unit_id', 'phone_rewarded_ad_unit_id',
  'tv_banner_ad_unit_id', 'tv_interstitial_ad_unit_id'
]);

function maskValue(key, val) {
  if (val === undefined || val === null || val === '') return '<em>not set</em>';
  if (MASKED_FIELDS.has(key)) {
    if (!val) return '<em>not set</em>';
    return val.slice(0, 4) + '••••••••';
  }
  return escapeHtml(String(val));
}

function boolDisplay(val) {
  return val ? '<span class="badge-enabled">Enabled</span>' : '<span class="badge-disabled">Disabled</span>';
}

function providerCard(name, p) {
  const enabled = p?.enabled ? boolDisplay(true) : boolDisplay(false);
  const movieParams = p?.movie_parameters;
  const tvParams = p?.tv_parameters;
  const iframeAttrs = p?.iframe_attributes;
  const hasParams = (movieParams && Object.keys(movieParams).length) ||
                     (tvParams && Object.keys(tvParams).length) ||
                     (iframeAttrs && Object.keys(iframeAttrs).length);

  const movieParamsStr = movieParams ? Object.entries(movieParams).map(([k, v]) => `${k}=${v}`).join(', ') : '';
  const tvParamsStr = tvParams ? Object.entries(tvParams).map(([k, v]) => `${k}=${v}`).join(', ') : '';
  const iframeStr = iframeAttrs ? Object.entries(iframeAttrs).map(([k, v]) => `${k}=${v}`).join(', ') : '';

  return `
    <div class="provider-readonly-card">
      ${enabled}
      <div class="provider-readonly-info">
        <div class="provider-readonly-name">${escapeHtml(p?.stream_provider_name || name)}</div>
        <div class="provider-readonly-template" title="${escapeHtml(p?.url || '')}">${escapeHtml(p?.url || '—')}</div>
        <div class="provider-readonly-template" title="${escapeHtml(p?.movie_url_template || '')}">Movie: ${escapeHtml(p?.movie_url_template || '—')}</div>
        <div class="provider-readonly-template" title="${escapeHtml(p?.tv_url_template || '')}">TV: ${escapeHtml(p?.tv_url_template || '—')}</div>
        ${iframeStr ? `<div class="provider-readonly-template" style="color:#E50914" title="${escapeHtml(iframeStr)}">iframe: ${escapeHtml(iframeStr)}</div>` : ''}
        ${movieParamsStr ? `<div class="provider-readonly-template" title="${escapeHtml(movieParamsStr)}">Movie params: ${escapeHtml(movieParamsStr)}</div>` : ''}
        ${tvParamsStr ? `<div class="provider-readonly-template" title="${escapeHtml(tvParamsStr)}">TV params: ${escapeHtml(tvParamsStr)}</div>` : ''}
      </div>
    </div>`;
}

async function loadCurrentSettings() {
  const $content = document.getElementById('currentSettingsContent');
  $content.innerHTML = '<div class="settings-readonly-loading">Loading settings from Firebase…</div>';

  const sections = ['streaming', 'api', 'ads', 'filters', 'network', 'features', 'app_packagenames', 'home_dialog'];
  const labels = {
    streaming:  'Streaming &amp; IPTV',
    api:        'API Keys',
    ads:        'AdMob Configuration',
    filters:    'Filter Lists',
    network:    'Network Settings',
    features:   'Feature Flags',
    app_packagenames: 'App Package Names',
    home_dialog: 'Home Dialog'
  };
  const displayFields = {
    streaming:  ['playlist_url', 'playlist_epg', 'schedule_api', 'playlist_cache_duration'],
    api:        ['tmdb_bearer_token', 'trakt_client_id', 'trakt_client_secret'],
    ads:        ['enable_test_ads', 'use_test_ads', 'phone_banner_ad_unit_id', 'phone_interstitial_ad_unit_id', 'phone_rewarded_ad_unit_id', 'tv_banner_ad_unit_id', 'tv_interstitial_ad_unit_id'],
    filters:    ['enable_custom_filters', 'easylist_url', 'easyprivacy_url', 'custom_filters_url', 'update_interval_hours', 'filter_timeout_ms', 'filter_fallback_easylist', 'filter_fallback_easyprivacy'],
    network:    ['api_cache_size_mb', 'cache_max_age_minutes', 'cache_max_stale_days', 'api_timeout_seconds', 'max_retries', 'retry_delay_ms'],
    features:   ['disable_ads_globally', 'cursor_speed', 'cursor_hide_delay_ms'],
    app_packagenames: ['app_type_phone', 'app_type_tv'],
    home_dialog: ['dialog_message']
  };
  const boolFields = new Set([
    'enable_test_ads', 'use_test_ads', 'enable_custom_filters', 'disable_ads_globally'
  ]);
  const displayKeys = {
    playlist_url: 'Playlist URL', playlist_epg: 'EPG URL', schedule_api: 'Schedule API',
    playlist_cache_duration: 'Cache Duration (h)',
    tmdb_bearer_token: 'TMDB Bearer Token', trakt_client_id: 'Trakt Client ID', trakt_client_secret: 'Trakt Client Secret',
    enable_test_ads: 'Test Ads (Admin)', use_test_ads: 'Use Test Ads (App)',
    phone_banner_ad_unit_id: 'Phone Banner', phone_interstitial_ad_unit_id: 'Phone Interstitial',
    phone_rewarded_ad_unit_id: 'Phone Rewarded', tv_banner_ad_unit_id: 'TV Banner', tv_interstitial_ad_unit_id: 'TV Interstitial',
    enable_custom_filters: 'Custom Filters', easylist_url: 'EasyList URL', easyprivacy_url: 'EasyPrivacy URL',
    custom_filters_url: 'Custom Filters URL', update_interval_hours: 'Update Interval (h)',
    filter_timeout_ms: 'Timeout (ms)', filter_fallback_easylist: 'EasyList Fallback', filter_fallback_easyprivacy: 'EasyPrivacy Fallback',
    api_cache_size_mb: 'Cache Size (MB)', cache_max_age_minutes: 'Cache Max Age (min)', cache_max_stale_days: 'Cache Max Stale (days)',
    api_timeout_seconds: 'API Timeout (s)', max_retries: 'Max Retries', retry_delay_ms: 'Retry Delay (ms)',
    disable_ads_globally: 'Ads Globally', cursor_speed: 'Cursor Speed (px)', cursor_hide_delay_ms: 'Cursor Hide Delay (ms)',
    app_type_phone: 'Phone Package', app_type_tv: 'TV Package',
    dialog_message: 'Dialog Message'
  };

  try {
    // Fetch all sections in parallel
    const results = await Promise.allSettled(
      sections.map(sec =>
        apiCall('GET', `/admin/config/${sec}?idToken=${encodeURIComponent(idToken)}`)
          .then(d => [sec, d])
      )
    );

    let html = '';

    for (let idx = 0; idx < results.length; idx++) {
      const result = results[idx];
      const sec = sections[idx];
      if (result.status !== 'fulfilled') {
        html += `<div class="settings-readonly-section">
          <h4>${escapeHtml(labels[sec] || sec)}</h4>
          <div class="settings-readonly-error">Failed to load: ${escapeHtml(result.reason?.message || 'Unknown error')}</div>
        </div>`;
        continue;
      }
      const data = result.value[1];
      const fields = displayFields[sec] || [];

      if (sec === 'features' && data?.providers !== undefined) {
        // Providers section rendered below
      }

      let rows = '';
      for (const key of fields) {
        const val = data?.[key];
        if (boolFields.has(key)) {
          rows += `<div class="settings-readonly-row">
            <span class="settings-readonly-key">${escapeHtml(displayKeys[key] || key)}</span>
            <span class="settings-readonly-val">${boolDisplay(!!val)}</span>
          </div>`;
        } else if (key === 'playlist_url' || key === 'playlist_epg' || key === 'schedule_api' || key === 'easylist_url' || key === 'easyprivacy_url' || key === 'custom_filters_url' || key === 'filter_fallback_easylist' || key === 'filter_fallback_easyprivacy') {
          rows += `<div class="settings-readonly-row">
            <span class="settings-readonly-key">${escapeHtml(displayKeys[key] || key)}</span>
            <span class="settings-readonly-val">${maskValue(key, val)}</span>
          </div>`;
        } else {
          rows += `<div class="settings-readonly-row">
            <span class="settings-readonly-key">${escapeHtml(displayKeys[key] || key)}</span>
            <span class="settings-readonly-val ${MASKED_FIELDS.has(key) ? 'masked' : ''}">${maskValue(key, val)}</span>
          </div>`;
        }
      }

      html += `<div class="settings-readonly-section">
        <h4>${escapeHtml(labels[sec] || sec)}</h4>
        ${rows || '<div class="settings-readonly-empty">No data</div>'}
      </div>`;
    }

    // Fetch and render providers separately
    let providersHtml = '';
    try {
      const providersData = await apiCall('GET', `/admin/providers?idToken=${encodeURIComponent(idToken)}`);
      const names = Object.keys(providersData || {});
      if (names.length) {
        providersHtml = names.map(n => providerCard(n, providersData[n])).join('');
      } else {
        providersHtml = '<div class="settings-readonly-empty">No providers configured</div>';
      }
    } catch (e) {
      providersHtml = `<div class="settings-readonly-error">Failed to load providers: ${escapeHtml(e.message)}</div>`;
    }
    html += `<div class="settings-readonly-section">
      <h4>Stream Providers</h4>
      ${providersHtml}
    </div>`;

    $content.innerHTML = html;
  } catch (err) {
    $content.innerHTML = `<div class="settings-readonly-error">Failed to load settings: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById('refreshCurrentSettings')?.addEventListener('click', loadCurrentSettings);

// ── SETTINGS ───────────────────────────────────────────────────────
async function checkApiStatus() {
  $apiStatus.textContent = 'Checking...';
  $apiStatus.className = 'status-badge';
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (res.ok) {
      $apiStatus.textContent = 'Connected';
      $apiStatus.className = 'status-badge ok';
    } else {
      $apiStatus.textContent = 'Error';
      $apiStatus.className = 'status-badge error';
    }
  } catch (err) {
    $apiStatus.textContent = 'Offline';
    $apiStatus.className = 'status-badge error';
  }

  // Show current admin UID (from verified token)
  if (auth && auth.currentUser) {
    $currentAdminUid.textContent = auth.currentUser.uid;
    $userName.textContent = auth.currentUser.displayName || auth.currentUser.email?.split('@')[0] || 'Admin';
    $userEmail.textContent = auth.currentUser.email || '';
    if (auth.currentUser.photoURL) {
      $userAvatar.src = auth.currentUser.photoURL;
      $userAvatar.style.display = 'block';
    }
  }
}

// Export data
document.getElementById('exportData').addEventListener('click', async () => {
  showToast('Fetching all users data...', 'info');
  try {
    const res = await apiCall('GET', `/admin/users?idToken=${encodeURIComponent(idToken)}&limit=1000`);
    const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kiduyutv-users-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Export complete!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── APP CONFIG (Settings → all config sections) ───────────────────
const CONFIG_SECTIONS = [
  {
    id: 'streaming',
    fields: [
      { id: 'streamingPlaylistUrl', name: 'playlist_url' },
      { id: 'streamingPlaylistEpg', name: 'playlist_epg' },
      { id: 'streamingScheduleApi', name: 'schedule_api' },
      { id: 'streamingCacheDuration', name: 'playlist_cache_duration', type: 'number' }
    ],
    metaId: 'streamingMeta',
    saveLabel: 'Streaming configuration'
  },
  {
    id: 'api',
    fields: [
      { id: 'apiTmdbToken', name: 'tmdb_bearer_token' },
      { id: 'apiTraktClientId', name: 'trakt_client_id' },
      { id: 'apiTraktClientSecret', name: 'trakt_client_secret' }
    ],
    saveLabel: 'API configuration'
  },
  {
    id: 'ads',
    fields: [
      { id: 'adsEnableTestAds',  name: 'enable_test_ads', type: 'boolean' },
      { id: 'adsUseTestAds',     name: 'use_test_ads',   type: 'boolean' },
      { id: 'adsPhoneBanner',    name: 'phone_banner_ad_unit_id' },
      { id: 'adsPhoneInterstitial', name: 'phone_interstitial_ad_unit_id' },
      { id: 'adsPhoneRewarded',  name: 'phone_rewarded_ad_unit_id' },
      { id: 'adsTvBanner',       name: 'tv_banner_ad_unit_id' },
      { id: 'adsTvInterstitial', name: 'tv_interstitial_ad_unit_id' }
    ],
    saveLabel: 'Ad configuration'
  },
  {
    id: 'filters',
    fields: [
      { id: 'filtersEnableCustom',    name: 'enable_custom_filters',     type: 'boolean' },
      { id: 'filtersEasyList',        name: 'easylist_url' },
      { id: 'filtersEasyPrivacy',     name: 'easyprivacy_url' },
      { id: 'filtersCustomFilters',   name: 'custom_filters_url' },
      { id: 'filtersUpdateInterval',   name: 'update_interval_hours', type: 'number' },
      { id: 'filtersTimeout',          name: 'filter_timeout_ms',         type: 'number' },
      { id: 'filtersFallbackEasyList',    name: 'filter_fallback_easylist' },
      { id: 'filtersFallbackEasyPrivacy', name: 'filter_fallback_easyprivacy' }
    ],
    saveLabel: 'Filter lists'
  },
  {
    id: 'network',
    fields: [
      { id: 'networkCacheSize',    name: 'api_cache_size_mb',       type: 'number' },
      { id: 'networkCacheMaxAge', name: 'cache_max_age_minutes',   type: 'number' },
      { id: 'networkCacheMaxStale',name: 'cache_max_stale_days',   type: 'number' },
      { id: 'networkTimeout',      name: 'api_timeout_seconds',     type: 'number' },
      { id: 'networkMaxRetries',  name: 'max_retries',             type: 'number' },
      { id: 'networkRetryDelay',  name: 'retry_delay_ms',          type: 'number' }
    ],
    saveLabel: 'Network settings'
  },
  {
    id: 'features',
    fields: [
      { id: 'featuresDisableAds',      name: 'disable_ads_globally', type: 'boolean' },
      { id: 'featuresCursorSpeed',      name: 'cursor_speed',          type: 'number' },
      { id: 'featuresCursorHideDelay',  name: 'cursor_hide_delay_ms',  type: 'number' }
    ],
    saveLabel: 'Feature flags'
  },
  {
    id: 'app_packagenames',
    fields: [
      { id: 'appPackgenamesPhone', name: 'app_type_phone' },
      { id: 'appPackgenamesTv',    name: 'app_type_tv' }
    ],
    saveLabel: 'App package names'
  },
  {
    id: 'home_dialog',
    fields: [
      { id: 'homeDialogMessage', name: 'dialog_message' }
    ],
    saveLabel: 'Home dialog'
  }
];

function findConfigSection(id) {
  return CONFIG_SECTIONS.find(s => s.id === id);
}

function applyConfigToFields(section, data) {
  for (const field of section.fields) {
    const el = document.getElementById(field.id);
    if (!el) continue;
    if (field.type === 'boolean') el.checked = !!data[field.name];
    else el.value = data[field.name] != null ? data[field.name] : '';
  }
}

function readConfigFromFields(section) {
  const payload = {};
  for (const field of section.fields) {
    const el = document.getElementById(field.id);
    if (!el) continue;
    if (field.type === 'boolean') payload[field.name] = el.checked;
    else payload[field.name] = el.value;
  }
  return payload;
}

async function loadConfigSection(sectionId) {
  const section = findConfigSection(sectionId);
  if (!section) return;
  const $meta = section.metaId ? document.getElementById(section.metaId) : null;
  if ($meta) { $meta.textContent = 'Loading…'; $meta.className = 'form-hint'; }
  try {
    const data = await apiCall('GET', `/admin/config/${section.id}?idToken=${encodeURIComponent(idToken)}`);
    applyConfigToFields(section, data || {});
    if ($meta) {
      if (data && data.createdAt) {
        $meta.textContent = `Created: ${formatDate(Date.parse(data.createdAt))}`;
      } else {
        $meta.textContent = 'Not set yet';
      }
      $meta.className = 'form-hint';
    }
  } catch (err) {
    if ($meta) {
      $meta.textContent = `Failed to load: ${err.message}`;
      $meta.className = 'form-hint error';
    } else {
      showToast(err.message, 'error');
    }
  }
}

async function saveConfigSection(sectionId) {
  const section = findConfigSection(sectionId);
  if (!section) return;
  const $btn = document.getElementById(`save${section.id.charAt(0).toUpperCase() + section.id.slice(1)}Config`);
  const original = $btn ? $btn.innerHTML : '';
  if ($btn) {
    $btn.disabled = true;
    $btn.textContent = 'Saving…';
  }
  try {
    const payload = { idToken, ...readConfigFromFields(section) };
    const res = await apiCall('PUT', `/admin/config/${section.id}`, payload);
    showToast(`${section.saveLabel} saved`, 'success');
    if (section.metaId && res.createdAt) {
      const $meta = document.getElementById(section.metaId);
      if ($meta) {
        $meta.textContent = `Created: ${formatDate(Date.parse(res.createdAt))}`;
        $meta.className = 'form-hint';
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if ($btn) {
      $btn.disabled = false;
      $btn.innerHTML = original;
    }
  }
}

function clearConfigSection(sectionId) {
  const section = findConfigSection(sectionId);
  if (!section) return;
  for (const field of section.fields) {
    const el = document.getElementById(field.id);
    if (!el) continue;
    if (field.type === 'boolean') el.checked = false;
    else { el.value = ''; }
  }
  const firstInput = document.getElementById(section.fields[0].id);
  if (firstInput) firstInput.focus();
}

// Wire up save / clear buttons for every section.
['streaming', 'api', 'ads', 'filters', 'network', 'features', 'app_packagenames', 'home_dialog'].forEach(sectionId => {
  const cap = sectionId.charAt(0).toUpperCase() + sectionId.slice(1);
  const $save = document.getElementById(`save${cap}Config`);
  const $clear = document.getElementById(`clear${cap}Config`);
  if ($save) $save.addEventListener('click', () => saveConfigSection(sectionId));
  if ($clear) $clear.addEventListener('click', () => clearConfigSection(sectionId));
});

// ── STREAM PROVIDERS ────────────────────────────────────────────────
// Each provider stored at app_config/stream_providers_Configuration/<name>
// Fields: stream_provider_name, url, enabled, movie_url_template, tv_url_template,
//         iframe_attributes (object), allow_attributes (string),
//         movie_parameters (object), tv_parameters (object), createdAt
let providersMap = {}; // { [name]: providerData }
let editingProviderKey = null; // the RTDB key of the provider currently in the edit modal

async function loadProviders() {
  const $list = document.getElementById('providersList');
  const $meta = document.getElementById('providersMeta');
  if (!$list) return;
  if ($meta) { $meta.textContent = 'Loading…'; $meta.className = 'form-hint'; }
  try {
    const data = await apiCall('GET', `/admin/providers?idToken=${encodeURIComponent(idToken)}`);
    providersMap = (data && typeof data === 'object') ? data : {};
    renderProvidersList();
    if ($meta) {
      const names = Object.keys(providersMap);
      const enabledCount = names.filter(n => providersMap[n]?.enabled).length;
      $meta.textContent = names.length
        ? `${names.length} provider${names.length === 1 ? '' : 's'} (${enabledCount} enabled)`
        : 'No providers yet';
      $meta.className = 'form-hint';
    }
  } catch (err) {
    if ($meta) {
      $meta.textContent = `Failed to load: ${err.message}`;
      $meta.className = 'form-hint error';
    } else {
      showToast(err.message, 'error');
    }
  }
}

function mapToText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
}
function textToMap(text) {
  const map = {};
  if (!text) return map;
  text.trim().split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key) map[key] = val;
    }
  });
  return map;
}

function openEditProviderModal(rtdbKey) {
  const p = providersMap[rtdbKey];
  if (!p) return;
  editingProviderKey = rtdbKey;
  document.getElementById('editProviderName').textContent = rtdbKey;
  document.getElementById('editProviderDisplayName').value = p.stream_provider_name || rtdbKey;
  document.getElementById('editProviderUrl').value = p.url || '';
  document.getElementById('editProviderMovieUrl').value = p.movie_url_template || '';
  document.getElementById('editProviderTvUrl').value = p.tv_url_template || '';
  document.getElementById('editProviderIframeAttrs').value = mapToText(p.iframe_attributes);
  document.getElementById('editProviderAllowAttrs').value = p.allow_attributes || '';
  document.getElementById('editProviderMovieParams').value = mapToText(p.movie_parameters);
  document.getElementById('editProviderTvParams').value = mapToText(p.tv_parameters);
  document.getElementById('editProviderModal').classList.add('active');
}

function closeEditProviderModal() {
  document.getElementById('editProviderModal').classList.remove('active');
  editingProviderKey = null;
}

async function saveProviderFromModal() {
  if (!editingProviderKey) return;
  const rtdbKey = editingProviderKey;
  const p = providersMap[rtdbKey] || {};
  const payload = {
    stream_provider_name:  document.getElementById('editProviderDisplayName').value.trim() || rtdbKey,
    url:                  document.getElementById('editProviderUrl').value.trim(),
    enabled:            p.enabled !== undefined ? p.enabled : true,
    movie_url_template:   document.getElementById('editProviderMovieUrl').value.trim(),
    tv_url_template:      document.getElementById('editProviderTvUrl').value.trim(),
    iframe_attributes:    textToMap(document.getElementById('editProviderIframeAttrs').value),
    allow_attributes:     document.getElementById('editProviderAllowAttrs').value.trim(),
    movie_parameters:   textToMap(document.getElementById('editProviderMovieParams').value),
    tv_parameters:       textToMap(document.getElementById('editProviderTvParams').value)
  };
  try {
    const saved = await apiCall('PUT', `/admin/providers/${encodeURIComponent(rtdbKey)}`, { idToken, ...payload });
    providersMap[rtdbKey] = { ...p, ...payload, createdAt: p.createdAt || saved.createdAt || new Date().toISOString() };
    closeEditProviderModal();
    renderProvidersList();
    showToast(`Provider "${rtdbKey}" saved`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('closeEditProvider')?.addEventListener('click', closeEditProviderModal);
document.getElementById('editProviderModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('editProviderModal')) closeEditProviderModal();
});
document.getElementById('saveEditProvider')?.addEventListener('click', saveProviderFromModal);

function renderProvidersList() {
  const $list = document.getElementById('providersList');
  if (!$list) return;
  const names = Object.keys(providersMap).sort();
  if (!names.length) {
    $list.innerHTML = '<div class="empty-state">No providers added yet. Use the form below to add one.</div>';
    return;
  }

  $list.innerHTML = names.map(name => {
    const p = providersMap[name];
    const movieParams = p?.movie_parameters;
    const tvParams = p?.tv_parameters;
    const iframeAttrs = p?.iframe_attributes;
    const hasMovieParams = movieParams && Object.keys(movieParams).length > 0;
    const hasTvParams = tvParams && Object.keys(tvParams).length > 0;
    const hasIframeAttrs = iframeAttrs && Object.keys(iframeAttrs).length > 0;
    const uid = `card-${name.replace(/[^a-z0-9]/gi, '_')}`;

    const movieParamsHtml = hasMovieParams
      ? Object.entries(movieParams).map(([k, v]) => `<div class="provider-param-row"><span class="provider-param-key">${escapeHtml(k)}</span>=<span class="provider-param-val">${escapeHtml(String(v))}</span></div>`).join('')
      : '<span style="color:#4a4f5c;font-style:italic">none</span>';
    const tvParamsHtml = hasTvParams
      ? Object.entries(tvParams).map(([k, v]) => `<div class="provider-param-row"><span class="provider-param-key">${escapeHtml(k)}</span>=<span class="provider-param-val">${escapeHtml(String(v))}</span></div>`).join('')
      : '<span style="color:#4a4f5c;font-style:italic">none</span>';
    const iframeAttrsHtml = hasIframeAttrs
      ? Object.entries(iframeAttrs).map(([k, v]) => `<div class="provider-param-row"><span class="provider-param-key">${escapeHtml(k)}</span>=<span class="provider-param-val">${escapeHtml(String(v))}</span></div>`).join('')
      : '<span style="color:#4a4f5c;font-style:italic">none</span>';

    return `
    <div class="provider-card" id="${uid}">
      <div class="provider-card-header">
        <label class="toggle" title="${p?.enabled ? 'Enabled' : 'Disabled'}" style="flex-shrink:0">
          <input type="checkbox" data-provider-action="toggle" data-provider-name="${escapeHtml(name)}" ${p?.enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <div class="provider-main-info">
          <span class="provider-card-name">${escapeHtml(p?.stream_provider_name || name)}</span>
          <span class="provider-card-url">${escapeHtml(p?.url || '— no base URL —')}</span>
        </div>
        <div class="provider-card-actions">
          <button class="provider-edit-btn" data-provider-action="edit" data-provider-name="${escapeHtml(name)}">Edit</button>
          <button class="btn-icon" data-provider-action="delete" data-provider-name="${escapeHtml(name)}" title="Delete" style="flex-shrink:0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="provider-card-urls">
        <div class="provider-url-field">
          <span class="provider-url-label">Movie</span>
          <code class="provider-url-template" style="flex:1;min-width:0;word-break:break-all;font-size:11px">${escapeHtml(p?.movie_url_template || '— not set —')}</code>
        </div>
        <div class="provider-url-field">
          <span class="provider-url-label">TV</span>
          <code class="provider-url-template" style="flex:1;min-width:0;word-break:break-all;font-size:11px">${escapeHtml(p?.tv_url_template || '— not set —')}</code>
        </div>
      </div>
      <!-- iframe attributes collapsible -->
      <div class="provider-params-toggle" data-toggle="iframe-${uid}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        iframe Attributes
      </div>
      <div class="provider-iframe-section" id="iframe-${uid}">${iframeAttrsHtml}</div>
      <!-- movie params collapsible -->
      <div class="provider-params-toggle" data-toggle="movie-${uid}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        Movie Params
      </div>
      <div class="provider-params-content" id="movie-${uid}">${movieParamsHtml}</div>
      <!-- tv params collapsible -->
      <div class="provider-params-toggle" data-toggle="tv-${uid}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        TV Params
      </div>
      <div class="provider-params-content" id="tv-${uid}">${tvParamsHtml}</div>
    </div>`;
  }).join('');

  // Toggle
  $list.querySelectorAll('[data-provider-action="toggle"]').forEach(input => {
    input.addEventListener('change', async (e) => {
      e.stopPropagation();
      const n = e.target.dataset.providerName;
      if (!providersMap[n]) return;
      providersMap[n].enabled = e.target.checked;
      await saveSingleProvider(n);
    });
  });

  // Edit button
  $list.querySelectorAll('[data-provider-action="edit"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditProviderModal(btn.dataset.providerName);
    });
  });

  // Delete button
  $list.querySelectorAll('[data-provider-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const n = btn.dataset.providerName;
      const confirmed = await showConfirm('Delete Provider', `Remove "${n}" from stream providers?`);
      if (!confirmed) return;
      try {
        await apiCall('DELETE', `/admin/providers/${encodeURIComponent(n)}`, { idToken });
        delete providersMap[n];
        renderProvidersList();
        showToast(`Provider "${n}" deleted`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Collapsible params
  $list.querySelectorAll('.provider-params-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const targetId = toggle.dataset.toggle;
      const content = document.getElementById(targetId);
      toggle.classList.toggle('open');
      content?.classList.toggle('open');
    });
  });
}

// Save a single provider (used after toggle)
async function saveSingleProvider(name) {
  const p = providersMap[name];
  if (!p) return;
  try {
    await apiCall('PUT', `/admin/providers/${encodeURIComponent(name)}`, { idToken, ...p });
    showToast(`Provider "${name}" saved`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    await loadProviders();
  }
}

// Add a new provider
async function addProvider() {
  const name     = document.getElementById('providerName').value.trim();
  const url      = document.getElementById('providerUrl').value.trim();
  const movieUrl = document.getElementById('providerMovieUrl').value.trim();
  const tvUrl    = document.getElementById('providerTvUrl').value.trim();
  if (!name) {
    showToast('Provider name is required', 'error');
    document.getElementById('providerName').focus();
    return;
  }
  if (providersMap[name]) {
    showToast(`Provider "${name}" already exists. Use Edit instead.`, 'error');
    return;
  }
  const payload = {
    stream_provider_name: name, url, enabled: true,
    movie_url_template: movieUrl, tv_url_template: tvUrl,
    iframe_attributes: {}, allow_attributes: '',
    movie_parameters: {}, tv_parameters: {}
  };
  try {
    const saved = await apiCall('PUT', `/admin/providers/${encodeURIComponent(name)}`, { idToken, ...payload });
    providersMap[name] = { ...payload, createdAt: saved.createdAt || new Date().toISOString() };
    document.getElementById('providerName').value = '';
    document.getElementById('providerUrl').value = '';
    document.getElementById('providerMovieUrl').value = '';
    document.getElementById('providerTvUrl').value = '';
    document.getElementById('providerName').focus();
    renderProvidersList();
    showToast(`Provider "${name}" added`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function clearProvidersForm() {
  document.getElementById('providerName').value = '';
  document.getElementById('providerUrl').value = '';
  document.getElementById('providerMovieUrl').value = '';
  document.getElementById('providerTvUrl').value = '';
  document.getElementById('providerName').focus();
}

document.getElementById('addProviderBtn')?.addEventListener('click', addProvider);
document.getElementById('clearProvidersConfig')?.addEventListener('click', clearProvidersForm);

// ── LOGIN FORM ──────────────────────────────────────────────────────
$loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  $loginBtn.disabled = true;
  $loginBtn.innerHTML = '<span class="btn-loader"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg></span>';
  $loginError.style.display = 'none';
  await handleLogin(email, password);
});

// ── GOOGLE SIGN IN ──────────────────────────────────────────────────
document.getElementById('googleLoginBtn').addEventListener('click', handleGoogleLogin);

// ── LOGOUT ─────────────────────────────────────────────────────────
$logoutBtn.addEventListener('click', logout);

// ── SIDEBAR TOGGLE (mobile) ─────────────────────────────────────────
const $sidebarToggle = document.getElementById('sidebarToggle');
const $sidebarBackdrop = document.getElementById('sidebarBackdrop');
const $sidebar = document.querySelector('.sidebar');

function closeSidebar() {
  $sidebar?.classList.remove('open');
  $sidebarBackdrop?.classList.remove('active');
}
function openSidebar() {
  $sidebar?.classList.add('open');
  $sidebarBackdrop?.classList.add('active');
}

$sidebarToggle?.addEventListener('click', openSidebar);
$sidebarBackdrop?.addEventListener('click', closeSidebar);

// Close sidebar when a nav item is clicked on mobile
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', closeSidebar);
});

// ── INIT ───────────────────────────────────────────────────────────
async function init() {
  // Try to restore session
  if (initialized && auth) {
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        try {
          idToken = await user.getIdToken();
          // Verify with backend
          await apiCall('POST', '/admin/verify', { idToken });
          showAdminScreen();
        } catch (e) {
          // Token might be invalid
          console.warn('Auth state invalid:', e.message);
        }
      }
    });
  }
}

init();