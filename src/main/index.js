const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const QueueManager = require('./queue');
const { openLMSBrowser, hasLMSSession, clearLMSSession, getLMSCookies } = require('./lms-browser');

let mainWindow = null;
let queueManager = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 840,
    minHeight: 580,
    backgroundColor: '#e2e8f0',
    title: 'BigBlueButton Downloader',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  queueManager = new QueueManager(mainWindow);

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Wire IPC handlers
ipcMain.handle('bbb:add-job', async (event, url, options = {}) => {
  if (!queueManager) throw new Error('Queue manager is not ready.');
  return await queueManager.addJob(url, options);
});

ipcMain.handle('bbb:open-lms-browser', async (event, initialUrl) => {
  const settings = queueManager ? queueManager.getSettings() : {};
  const targetUrl = initialUrl || settings.lmsPortalUrl || '';

  openLMSBrowser(
    targetUrl,
    ({ url }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bbb:lms-detected-url', { url });
      }
    },
    (savedPortalUrl) => {
      if (queueManager && savedPortalUrl) {
        queueManager.updateSettings({ lmsPortalUrl: savedPortalUrl });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bbb:settings-updated', queueManager.getSettings());
        }
      }
    }
  );
  return true;
});

ipcMain.handle('bbb:get-lms-status', async (event, optionalPortalUrl) => {
  const settings = queueManager ? queueManager.getSettings() : {};
  const portalUrl = optionalPortalUrl || settings.lmsPortalUrl || '';
  return await hasLMSSession(portalUrl);
});

ipcMain.handle('bbb:clear-lms-session', async () => {
  return await clearLMSSession();
});

ipcMain.on('bbb:lms-detected-recording', async (event, url) => {
  if (!queueManager) return;
  try {
    const cookies = await getLMSCookies(url);
    await queueManager.addJob(url, { cookies });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
    }
  } catch (err) {
    console.error('Failed to add detected LMS recording to queue:', err);
  }
});

ipcMain.handle('bbb:cancel-job', async (event, jobId) => {
  if (!queueManager) return;
  return await queueManager.cancelJob(jobId);
});

ipcMain.handle('bbb:pause-job', async (event, jobId) => {
  if (!queueManager) return;
  return await queueManager.pauseJob(jobId);
});

ipcMain.handle('bbb:resume-job', async (event, jobId) => {
  if (!queueManager) return;
  return await queueManager.resumeJob(jobId);
});

ipcMain.handle('bbb:get-jobs', () => {
  return queueManager ? queueManager.getAllJobs() : [];
});

ipcMain.handle('bbb:get-settings', () => {
  return queueManager ? queueManager.getSettings() : {};
});

ipcMain.handle('bbb:save-settings', (event, settings) => {
  return queueManager ? queueManager.updateSettings(settings) : {};
});

ipcMain.handle('bbb:open-folder', async (event, targetPath) => {
  if (!targetPath) return false;
  try {
    shell.showItemInFolder(targetPath);
    return true;
  } catch (err) {
    console.error('Failed to open file in folder:', err);
    return false;
  }
});

ipcMain.handle('bbb:open-file', async (event, filePath) => {
  if (!filePath) return false;
  try {
    await shell.openPath(filePath);
    return true;
  } catch (err) {
    console.error('Failed to open file:', err);
    return false;
  }
});

ipcMain.handle('bbb:select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Output Directory for Recordings'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Cancel active jobs and clean temporary resources
  if (queueManager && queueManager.activeJobId) {
    queueManager.cancelJob(queueManager.activeJobId);
  }
});
