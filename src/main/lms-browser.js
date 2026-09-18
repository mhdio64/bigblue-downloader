const { BrowserWindow, BrowserView, session, ipcMain } = require('electron');
const path = require('path');

let lmsWindow = null;
let currentBrowserView = null;
const LMS_PARTITION = 'persist:lms';

// Domains to ignore when checking if the user is authenticated in an LMS
const IGNORED_DOMAINS = [
  'google.com',
  'google.co',
  'gstatic.com',
  'googleapis.com',
  'cloudflare.com',
  'recaptcha.net',
  'bing.com'
];

function isIgnoredDomain(rawDomain) {
  if (!rawDomain) return true;
  const d = rawDomain.toLowerCase().replace(/^\./, '');
  if (d.includes('google.') || d === 'google' || d.endsWith('.google.com') || d === 'google.com') return true;
  if (d.includes('gstatic.') || d.includes('googleapis.') || d.includes('recaptcha.')) return true;
  if (d.includes('cloudflare.') || d.includes('bing.')) return true;
  return false;
}

/**
 * Formats Electron cookie objects array into a standard HTTP Cookie header string
 * @param {Array<{ name: string, value: string }>} cookies 
 * @returns {string}
 */
function formatCookiesForHeader(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return '';
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Retrieves all stored cookies for a target URL or all non-ignored cookies from the LMS session
 * @param {string} [targetUrl] 
 * @returns {Promise<string>}
 */
async function getLMSCookies(targetUrl) {
  try {
    const lmsSession = session.fromPartition(LMS_PARTITION);
    let cookies = [];
    if (targetUrl) {
      cookies = await lmsSession.cookies.get({ url: targetUrl });
    }
    // If no cookies found for specific URL, fetch all cookies in partition
    if (!cookies || cookies.length === 0) {
      cookies = await lmsSession.cookies.get({});
    }
    return formatCookiesForHeader(cookies);
  } catch (err) {
    console.error('Failed to get LMS cookies:', err);
    return '';
  }
}

/**
 * Checks if the user has an active stored session in the LMS partition.
 * Excludes generic search engine and CDN cookies (e.g. Google).
 * 
 * @param {string} [portalUrl] Optional specific portal URL to check
 * @returns {Promise<boolean>}
 */
async function hasLMSSession(portalUrl) {
  try {
    const lmsSession = session.fromPartition(LMS_PARTITION);
    const cookies = await lmsSession.cookies.get({});
    if (!cookies || cookies.length === 0) return false;

    // Filter out generic search engines and public CDN cookies
    const validCookies = cookies.filter(c => !isIgnoredDomain(c.domain));

    if (validCookies.length === 0) return false;

    // If portalUrl is provided, check if cookies match portal host/domain
    if (portalUrl && typeof portalUrl === 'string' && portalUrl.trim()) {
      try {
        const portalHost = new URL(portalUrl.trim()).hostname.toLowerCase();
        return validCookies.some(c => {
          const cookieDomain = (c.domain || '').toLowerCase().replace(/^\./, '');
          return (
            portalHost === cookieDomain ||
            portalHost.endsWith('.' + cookieDomain) ||
            cookieDomain.endsWith('.' + portalHost)
          );
        });
      } catch {
        return validCookies.length > 0;
      }
    }

    return validCookies.length > 0;
  } catch {
    return false;
  }
}

/**
 * Clears all cookies and cache in the LMS session
 * @returns {Promise<boolean>}
 */
async function clearLMSSession() {
  try {
    const lmsSession = session.fromPartition(LMS_PARTITION);
    await lmsSession.clearStorageData();
    return true;
  } catch (err) {
    console.error('Failed to clear LMS session:', err);
    return false;
  }
}

/**
 * Tests if a given URL is likely a BigBlueButton recording link
 * @param {string} url 
 * @returns {boolean}
 */
function isBBBUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return (
    url.includes('/playback/presentation/2.') ||
    url.includes('/playback/presentation/playback.html') ||
    url.includes('/playback.html?meetingId=') ||
    /\/presentation\/[a-z0-9_-]+/i.test(url)
  );
}

// Global IPC handlers for toolbar actions (registered once)
let lmsIpcInitialized = false;
let activeMeetingCallback = null;
let activeSavePortalCallback = null;

function initLmsToolbarIpc() {
  if (lmsIpcInitialized) return;
  lmsIpcInitialized = true;

  ipcMain.on('lms-nav:go', (event, rawQuery) => {
    if (!currentBrowserView || currentBrowserView.webContents.isDestroyed()) return;
    let target = (rawQuery || '').trim();
    if (!target) return;

    // If it's a full URL or domain (e.g. lms.ut.ac.ir), navigate directly; otherwise perform Google Search
    const isUrl = /^https?:\/\//i.test(target) || (/^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(target) && !target.includes(' '));
    if (isUrl) {
      if (!target.startsWith('http://') && !target.startsWith('https://')) {
        target = 'https://' + target;
      }
    } else {
      target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
    }
    currentBrowserView.webContents.loadURL(target);
  });

  ipcMain.on('lms-nav:back', () => {
    if (currentBrowserView && currentBrowserView.webContents.canGoBack()) {
      currentBrowserView.webContents.goBack();
    }
  });

  ipcMain.on('lms-nav:forward', () => {
    if (currentBrowserView && currentBrowserView.webContents.canGoForward()) {
      currentBrowserView.webContents.goForward();
    }
  });

  ipcMain.on('lms-nav:reload', () => {
    if (currentBrowserView && !currentBrowserView.webContents.isDestroyed()) {
      currentBrowserView.webContents.reload();
    }
  });

  ipcMain.on('lms-nav:home', () => {
    if (currentBrowserView && !currentBrowserView.webContents.isDestroyed()) {
      currentBrowserView.webContents.loadFile(path.join(__dirname, '../renderer/lms-welcome.html'));
    }
  });

  ipcMain.on('lms-nav:set-default-portal', (event, portalUrl) => {
    if (activeSavePortalCallback) {
      activeSavePortalCallback(portalUrl);
    }
  });
}

/**
 * Opens or focuses the in-app LMS browser window with an integrated address bar toolbar
 * 
 * @param {string} [initialUrl] Starting URL (e.g. university Moodle page)
 * @param {function} [onMeetingDetected] Callback when a recording is captured: ({ url, cookies }) => void
 * @param {function} [onSaveDefaultPortal] Callback when user clicks 'Set Default Portal'
 * @returns {BrowserWindow}
 */
function openLMSBrowser(initialUrl, onMeetingDetected, onSaveDefaultPortal) {
  initLmsToolbarIpc();
  activeMeetingCallback = onMeetingDetected || null;
  activeSavePortalCallback = onSaveDefaultPortal || null;

  if (lmsWindow && !lmsWindow.isDestroyed()) {
    lmsWindow.focus();
    if (initialUrl && currentBrowserView && !currentBrowserView.webContents.isDestroyed()) {
      currentBrowserView.webContents.loadURL(initialUrl);
    }
    return lmsWindow;
  }

  // 1. Create main wrapper window (holds top toolbar)
  lmsWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 840,
    minHeight: 520,
    title: 'University / LMS Portal Browser',
    backgroundColor: '#f1f5f9',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/lms-toolbar-preload.js')
    }
  });

  // 2. Create BrowserView for web content with persistent partition
  const TOOLBAR_HEIGHT = 50;
  currentBrowserView = new BrowserView({
    webPreferences: {
      partition: LMS_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'lms-preload.js')
    }
  });

  lmsWindow.setBrowserView(currentBrowserView);

  function updateViewBounds() {
    if (!lmsWindow || lmsWindow.isDestroyed() || !currentBrowserView) return;
    const bounds = lmsWindow.getContentBounds();
    currentBrowserView.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: bounds.width,
      height: Math.max(0, bounds.height - TOOLBAR_HEIGHT)
    });
  }

  updateViewBounds();
  lmsWindow.on('resize', updateViewBounds);

  // 3. Load toolbar HTML into window
  lmsWindow.loadFile(path.join(__dirname, '../renderer/lms-window.html'));

  // 4. Inspect navigation and sync state with toolbar
  async function handleNav(url) {
    if (!lmsWindow || lmsWindow.isDestroyed() || !currentBrowserView) return;

    const canGoBack = currentBrowserView.webContents.canGoBack();
    const canGoForward = currentBrowserView.webContents.canGoForward();

    lmsWindow.webContents.send('lms-nav:state-changed', {
      url,
      canGoBack,
      canGoForward
    });

    // Check if URL is BigBlueButton recording
    if (isBBBUrl(url)) {
      lmsWindow.webContents.send('lms-nav:recording-detected', { url });

      // Inject floating helper banner inside the page
      try {
        await currentBrowserView.webContents.executeJavaScript(`
          (function() {
            if (document.getElementById('bbb-auto-capture-banner')) return;
            const banner = document.createElement('div');
            banner.id = 'bbb-auto-capture-banner';
            banner.style.cssText = [
              'position: fixed',
              'top: 16px',
              'left: 50%',
              'transform: translateX(-50%)',
              'background: #4338ca',
              'color: #ffffff',
              'padding: 12px 20px',
              'border-radius: 12px',
              'box-shadow: 0 10px 30px rgba(0,0,0,0.3)',
              'z-index: 9999999',
              'font-family: system-ui, sans-serif',
              'display: flex',
              'align-items: center',
              'gap: 12px',
              'font-size: 13.5px',
              'font-weight: 600',
              'direction: ltr',
              'border: 1px solid rgba(255,255,255,0.2)'
            ].join(';');

            banner.innerHTML = \`
              <span>🎬 BigBlueButton Recording Detected!</span>
              <button id="btn-import-bbb" style="background:#ffffff;color:#4338ca;border:none;padding:6px 14px;border-radius:6px;font-weight:700;cursor:pointer;font-size:12.5px;">Add to Downloader</button>
              <button id="btn-close-bbb" style="background:transparent;color:#ffffff;border:none;cursor:pointer;font-size:16px;line-height:1;">✕</button>
            \`;

            document.body.appendChild(banner);

            document.getElementById('btn-import-bbb').onclick = () => {
              window.lmsBridge.sendMeetingUrl(window.location.href);
              banner.style.background = '#059669';
              banner.querySelector('span').textContent = '✔ Added to Download Queue!';
              setTimeout(() => banner.remove(), 2500);
            };

            document.getElementById('btn-close-bbb').onclick = () => banner.remove();
          })();
        `);
      } catch {}

      if (activeMeetingCallback) {
        const cookies = await getLMSCookies(url);
        activeMeetingCallback({ url, cookies });
      }
    }
  }

  currentBrowserView.webContents.on('did-navigate', (event, url) => handleNav(url));
  currentBrowserView.webContents.on('did-navigate-in-page', (event, url) => handleNav(url));
  currentBrowserView.webContents.on('did-redirect-navigation', (event, url) => handleNav(url));

  // 5. Navigate BrowserView to initial URL or local Welcome page
  if (initialUrl && (initialUrl.startsWith('http://') || initialUrl.startsWith('https://'))) {
    currentBrowserView.webContents.loadURL(initialUrl);
  } else {
    currentBrowserView.webContents.loadFile(path.join(__dirname, '../renderer/lms-welcome.html'));
  }

  lmsWindow.on('closed', () => {
    lmsWindow = null;
    currentBrowserView = null;
  });

  return lmsWindow;
}

module.exports = {
  LMS_PARTITION,
  formatCookiesForHeader,
  getLMSCookies,
  hasLMSSession,
  clearLMSSession,
  openLMSBrowser,
  isBBBUrl
};
