const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bbbApi', {
  // Actions
  addJob: (url, options) => ipcRenderer.invoke('bbb:add-job', url, options),
  pauseJob: (jobId) => ipcRenderer.invoke('bbb:pause-job', jobId),
  resumeJob: (jobId) => ipcRenderer.invoke('bbb:resume-job', jobId),
  cancelJob: (jobId) => ipcRenderer.invoke('bbb:cancel-job', jobId),
  getJobs: () => ipcRenderer.invoke('bbb:get-jobs'),
  getSettings: () => ipcRenderer.invoke('bbb:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('bbb:save-settings', settings),
  openFolder: (filePath) => ipcRenderer.invoke('bbb:open-folder', filePath),
  openFile: (filePath) => ipcRenderer.invoke('bbb:open-file', filePath),
  selectDirectory: () => ipcRenderer.invoke('bbb:select-directory'),

  // LMS In-App Browser & Session
  openLMSBrowser: (initialUrl) => ipcRenderer.invoke('bbb:open-lms-browser', initialUrl),
  getLMSStatus: (portalUrl) => ipcRenderer.invoke('bbb:get-lms-status', portalUrl),
  clearLMSSession: () => ipcRenderer.invoke('bbb:clear-lms-session'),

  // Event Subscriptions
  onSettingsUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bbb:settings-updated', handler);
    return () => ipcRenderer.removeListener('bbb:settings-updated', handler);
  },
  onLMSDetectedUrl: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bbb:lms-detected-url', handler);
    return () => ipcRenderer.removeListener('bbb:lms-detected-url', handler);
  },
  onJobAdded: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bbb:job-added', handler);
    return () => ipcRenderer.removeListener('bbb:job-added', handler);
  },
  onJobUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bbb:job-updated', handler);
    return () => ipcRenderer.removeListener('bbb:job-updated', handler);
  },
  onJobProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bbb:job-progress', handler);
    return () => ipcRenderer.removeListener('bbb:job-progress', handler);
  },
  onJobCompleted: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bbb:job-completed', handler);
    return () => ipcRenderer.removeListener('bbb:job-completed', handler);
  },
  onJobFailed: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bbb:job-failed', handler);
    return () => ipcRenderer.removeListener('bbb:job-failed', handler);
  },
  onJobCancelled: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bbb:job-cancelled', handler);
    return () => ipcRenderer.removeListener('bbb:job-cancelled', handler);
  }
});
