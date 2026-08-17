"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settings", {
  get: () => ipcRenderer.invoke("config:get"),
  save: (config) => ipcRenderer.invoke("config:save", config),
  pickDisplay: (index) => ipcRenderer.invoke("config:pickDisplay", index),
  testHost: (host) => ipcRenderer.invoke("frigate:test", host),
  update: {
    state: () => ipcRenderer.invoke("update:state"),
    act: (action) => ipcRenderer.invoke("update:act", action),
    // download progress arrives on its own, so the page cannot only ask
    onState: (fn) => ipcRenderer.on("update:state", (_event, view) => fn(view)),
  },
});
