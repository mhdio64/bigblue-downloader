const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lmsBridge', {
  sendMeetingUrl: (url) => ipcRenderer.send('bbb:lms-detected-recording', url)
});
