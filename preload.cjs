const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__HSP_DESKTOP__", {
  openOAuthUrl: (authUrl, apiOrigin) => ipcRenderer.invoke("hsp-open-oauth-url", { authUrl, apiOrigin }),
  /** True in the packaged Electron shell (screen share / desktop bridges). */
  isElectronShell: true,
});
