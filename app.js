/* app.js
 - Demonstrates token issuance, storage, expiry, automatic refresh and usage.
 - For demo only: uses a mockAuthServer implementation.
 - Replace mockAuthServer.* calls with real fetch calls to your backend in production.
*/

const UI = {
  btnIssue: document.getElementById('btn-issue'),
  btnCall: document.getElementById('btn-call'),
  btnRevoke: document.getElementById('btn-revoke'),
  tokenInfo: document.getElementById('token-info'),
  log: document.getElementById('log')
};

/* ---------- Simple logger ---------- */
function log(...args) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} — ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  UI.log.prepend(line);
}

/* ---------- Token storage helpers ---------- */
/*
Stored format in localStorage under key 'auth':
{
  accessToken: "eyJ..",
  refreshToken: "rft..",
  expiresAt: 169... (ms since epoch)
}
*/
const STORAGE_KEY = 'auth';

function saveAuth(auth) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}
function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
  cancelScheduledRefresh();
}
function loadAuth() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

/* ---------- Expiry & refresh scheduling ---------- */
let refreshTimeoutId = null;

/*
scheduleRefresh:
  - schedules refresh to occur REFRESH_MARGIN ms before expiry.
  - if token is already expired, triggers immediate refresh.
*/
const REFRESH_MARGIN = 30 * 1000; // 30 seconds before expiry

function scheduleRefresh() {
  cancelScheduledRefresh();
  const auth = loadAuth();
  if (!auth || !auth.expiresAt) return;

  const now = Date.now();
  const msUntilExpiry = auth.expiresAt - now;
  const msUntilRefresh = Math.max(0, msUntilExpiry - REFRESH_MARGIN);

  log(`Token expires in ${Math.round(msUntilExpiry/1000)}s. Scheduling refresh in ${Math.round(msUntilRefresh/1000)}s.`);
  refreshTimeoutId = setTimeout(() => {
    refreshToken().catch(err => {
      log('Refresh failed:', err.message || err);
      // Optionally: prompt user to login again
    });
  }, msUntilRefresh);
}

function cancelScheduledRefresh() {
  if (refreshTimeoutId) {
    clearTimeout(refreshTimeoutId);
    refreshTimeoutId = null;
  }
}

/* ---------- Mock "backend" for demo ---------- */
/*
Replace these functions with real fetch() calls to your auth endpoints.
Server contract assumed:
 - POST /auth/login -> { accessToken, refreshToken, expiresIn } // expiresIn in seconds
 - POST /auth/refresh -> { accessToken, refreshToken, expiresIn }
 - POST /auth/revoke -> { success:true }
 - GET /protected -> returns 200 if accessToken valid
For demo we return tokens that expire quickly so you can see refresh behavior.
*/
const mockAuthServer = (() => {
  // simple in-memory "refresh tokens" store for the demo
  const validRefreshTokens = new Set();

  function makeToken(prefix='AT', lifetimeSeconds=90) {
    const token = `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    return { token, lifetimeSeconds };
  }

  return {
    async login() {
      // emulate network latency
      await new Promise(r => setTimeout(r, 300));
      const at = makeToken('AT', 90);   // access token valid 90s
      const rt = makeToken('RT', 300);  // refresh token valid 300s
      validRefreshTokens.add(rt.token);
      return {
        accessToken: at.token,
        refreshToken: rt.token,
        expiresIn: at.lifetimeSeconds
      };
    },

    async refresh({ refreshToken }) {
      await new Promise(r => setTimeout(r, 300));
      if (!validRefreshTokens.has(refreshToken)) {
        const err = new Error('Invalid refresh token');
        err.status = 401;
        throw err;
      }
      // issue new tokens
      const at = makeToken('AT', 90);
      const rt = makeToken('RT', 300);
      // rotate refresh token
      validRefreshTokens.delete(refreshToken);
      validRefreshTokens.add(rt.token);
      return {
        accessToken: at.token,
        refreshToken: rt.token,
        expiresIn: at.lifetimeSeconds
      };
    },

    async revoke({ refreshToken }) {
      await new Promise(r => setTimeout(r, 200));
      validRefreshTokens.delete(refreshToken);
      return { success: true };
    },

    async protectedEndpoint({ accessToken }) {
      await new Promise(r => setTimeout(r, 200));
      // in this mock we simply check that accessToken string contains "AT_"
      if (!accessToken || !accessToken.startsWith('AT_')) {
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }
      return { data: 'Secret data from protected API' };
    }
  };
})();

/* ---------- Auth flow functions ---------- */
async function issueToken() {
  log('Requesting tokens (login)...');
  const res = await mockAuthServer.login();
  const expiresAt = Date.now() + res.expiresIn * 1000; // ms
  const auth = {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresAt
  };
  saveAuth(auth);
  log('Tokens received and saved:', { accessToken: auth.accessToken.slice(0,20)+'…', refreshToken: auth.refreshToken.slice(0,20)+'…', expiresAt: new Date(expiresAt).toLocaleTimeString() });
  updateUI();
  scheduleRefresh();
}

async function refreshToken() {
  const auth = loadAuth();
  if (!auth || !auth.refreshToken) throw new Error('No refresh token available');

  log('Refreshing token using refreshToken (server call)...');
  const res = await mockAuthServer.refresh({ refreshToken: auth.refreshToken });
  const expiresAt = Date.now() + res.expiresIn * 1000;
  const newAuth = {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresAt
  };
  saveAuth(newAuth);
  log('Token refreshed:', { accessToken: newAuth.accessToken.slice(0,20)+'…', expiresAt: new Date(expiresAt).toLocaleTimeString() });
  updateUI();
  scheduleRefresh();
  return newAuth;
}

async function revokeToken() {
  const auth = loadAuth();
  if (!auth) { log('No token to revoke'); return; }
  try {
    await mockAuthServer.revoke({ refreshToken: auth.refreshToken });
    clearAuth();
    updateUI();
    log('Token revoked / logged out');
  } catch (err) {
    log('Revoke failed:', err.message || err);
  }
}

/* ---------- API request wrapper ---------- */
/*
apiRequest automatically:
  - loads saved token
  - checks expiry
  - refreshes if needed
  - attaches Authorization header
*/
async function apiRequest() {
  let auth = loadAuth();
  if (!auth) throw new Error('Not authenticated');

  const now = Date.now();
  if (auth.expiresAt <= now) {
    log('Access token already expired, attempting to refresh...');
    auth = await refreshToken(); // may throw
  } else if (auth.expiresAt - now <= REFRESH_MARGIN) {
    // close to expiry — refresh proactively
    log('Access token will expire soon; refreshing proactively...');
    auth = await refreshToken();
  }

  // Use auth.accessToken for the request
  log('Calling protected endpoint with accessToken prefix:', auth.accessToken.slice(0,8));
  const res = await mockAuthServer.protectedEndpoint({ accessToken: auth.accessToken });
  log('Protected API response:', res.data);
  return res;
}

/* ---------- UI update ---------- */
function updateUI() {
  const auth = loadAuth();
  if (!auth) {
    UI.tokenInfo.textContent = 'No token stored.';
  } else {
    const msLeft = Math.max(0, auth.expiresAt - Date.now());
    UI.tokenInfo.textContent = JSON.stringify({
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: new Date(auth.expiresAt).toISOString(),
      secondsLeft: Math.round(msLeft/1000)
    }, null, 2);
  }
}

/* ---------- Wire UI buttons ---------- */
UI.btnIssue.addEventListener('click', async () => {
  try {
    await issueToken();
  } catch (err) {
    log('Issue token error:', err.message || err);
  }
});

UI.btnCall.addEventListener('click', async () => {
  try {
    const res = await apiRequest();
    // do something with res
  } catch (err) {
    log('API call error:', err.message || err);
    if (err.status === 401) {
      log('Unauthorized — please login again.');
      clearAuth();
      updateUI();
    }
  }
});

UI.btnRevoke.addEventListener('click', async () => {
  await revokeToken();
});

/* initialize UI */
updateUI();
scheduleRefresh();

/* OPTIONAL: Visual countdown update every second for convenience */
setInterval(() => {
  updateUI();
}, 1000);
