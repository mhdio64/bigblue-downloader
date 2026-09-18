const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lmsToolbar', {
  navigate: (url) => ipcRenderer.send('lms-nav:go', url),
  goBack: () => ipcRenderer.send('lms-nav:back'),
  goForward: () => ipcRenderer.send('lms-nav:forward'),
  reload: () => ipcRenderer.send('lms-nav:reload'),
  goHome: () => ipcRenderer.send('lms-nav:home'),
  saveDefaultPortal: (url) => ipcRenderer.send('lms-nav:set-default-portal', url),
  importRecording: (url) => ipcRenderer.send('bbb:lms-detected-recording', url),
  onNavStateChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('lms-nav:state-changed', handler);
    return () => ipcRenderer.removeListener('lms-nav:state-changed', handler);
  },
  onRecordingDetected: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('lms-nav:recording-detected', handler);
    return () => ipcRenderer.removeListener('lms-nav:recording-detected', handler);
  }
});
