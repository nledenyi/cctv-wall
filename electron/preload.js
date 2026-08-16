"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settings", {
  get: () => ipcRenderer.invoke("config:get"),
  save: (config) => ipcRenderer.invoke("config:save", config),
  pickDisplay: (index) => ipcRenderer.invoke("config:pickDisplay", index),
  testHost: (host) => ipcRenderer.invoke("frigate:test", host),
});
