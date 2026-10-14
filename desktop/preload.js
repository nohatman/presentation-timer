'use strict';

// The dashboard window only: lets the dashboard show which screen each room
// is on and change it (same as the Output menu), and draw the app's own
// questions (close, restart...) in the window instead of Windows message
// boxes. The page sees nothing else of Electron. In a normal browser
// window.foxyApp is undefined.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('foxyApp', {
  getOutputs: () => ipcRenderer.invoke('outputs:get'),
  setScreenRoom: (displayId, roomId) => ipcRenderer.invoke('outputs:set', displayId, roomId),
  identifyScreens: () => ipcRenderer.invoke('outputs:identify'),
  onOutputs: (callback) => ipcRenderer.on('outputs:changed', (event, outputs) => callback(outputs)),
  // App questions: the page says it's showing one, then answers with the
  // chosen option's index.
  onDialog: (callback) => ipcRenderer.on('app:dialog', (event, request) => callback(request)),
  dialogShown: (id) => ipcRenderer.send('app:dialog-shown', id),
  dialogAnswer: (id, index) => ipcRenderer.send('app:dialog-answer', id, index),
});
