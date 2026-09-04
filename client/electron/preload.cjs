/**
 * The bridge between the page and the Mac shell.
 *
 * Outward: the timer's state for the menu bar widget, and the autostart
 * choice for the login item. Inward: menu taps as commands, which the page
 * applies to whatever live session it finds. Nothing is ever read back, and
 * no Node API leaks into the page — the timer works exactly the same with no
 * shell around it.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  setTray: (state) => ipcRenderer.send("set-tray", state),
  setAutoStart: (enabled) => ipcRenderer.send("set-autostart", enabled),
  onCommand: (handler) => {
    const listener = (_event, id) => handler(id);
    ipcRenderer.on("tray-command", listener);
    return () => ipcRenderer.removeListener("tray-command", listener);
  },
});
