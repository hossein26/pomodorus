/**
 * The only bridge between the page and the Mac shell.
 *
 * Two one-way sends: the timer's state for the menu bar widget, and the
 * autostart choice for the login item. Nothing is ever read back, and no
 * Node API leaks into the page — the timer works exactly the same with no
 * shell around it.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  setTray: (state) => ipcRenderer.send("set-tray", state),
  setAutoStart: (enabled) => ipcRenderer.send("set-autostart", enabled),
});
