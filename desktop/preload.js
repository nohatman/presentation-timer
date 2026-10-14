'use strict';

// The dashboard window only: lets the dashboard show which screen each room
// is on and change it (same as the Output menu). The page sees nothing else
// of Electron. In a normal browser window.foxyApp is undefined.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('foxyApp', {
  getOutputs: () => ipcRenderer.invoke('outputs:get'),
  setScreenRoom: (displayId, roomId) => ipcRenderer.invoke('outputs:set', displayId, roomId),
  identifyScreens: () => ipcRenderer.invoke('outputs:identify'),
  onOutputs: (callback) => ipcRenderer.on('outputs:changed', (event, outputs) => callback(outputs)),
});
