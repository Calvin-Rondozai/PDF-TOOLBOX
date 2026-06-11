const { contextBridge, ipcRenderer } = require("electron");

const pkg = require("../package.json");



contextBridge.exposeInMainWorld("appInfo", {

  version: pkg.version,

  developer: pkg.author || "Calvin",

  name: pkg.description || "Hello C — PDF Tool",

});



contextBridge.exposeInMainWorld("pdfApi", {

  openPdf: () => ipcRenderer.invoke("dialog:openPdf"),

  openPdfs: () => ipcRenderer.invoke("dialog:openPdfs"),

  savePdf: (defaultName) => ipcRenderer.invoke("dialog:savePdf", defaultName),

  saveAudio: (defaultName) => ipcRenderer.invoke("dialog:saveAudio", defaultName),

  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),

  openOffice: (kind) => ipcRenderer.invoke("dialog:openOffice", kind),

  openImages: () => ipcRenderer.invoke("dialog:openImages"),

  saveFile: (defaultName, extensions) => ipcRenderer.invoke("dialog:saveFile", defaultName, extensions),

  readFile: (path) => ipcRenderer.invoke("fs:readFile", path),

  writeFile: (path, data) => ipcRenderer.invoke("fs:writeFile", path, data),

  stat: (path) => ipcRenderer.invoke("fs:stat", path),

  basename: (path) => ipcRenderer.invoke("fs:basename", path),

  dirname: (path) => ipcRenderer.invoke("fs:dirname", path),

  extname: (path) => ipcRenderer.invoke("fs:extname", path),

  showInFolder: (path) => ipcRenderer.invoke("shell:showItemInFolder", path),

  runOp: (payload) => ipcRenderer.invoke("pdf:run", payload),

  ping: () => ipcRenderer.invoke("pdf:ping"),

  onProgress: (cb) => {

    const handler = (_, data) => cb(data);

    ipcRenderer.on("pdf:progress", handler);

    return () => ipcRenderer.removeListener("pdf:progress", handler);

  },

});



contextBridge.exposeInMainWorld("aiApi", {

  getSettings: () => ipcRenderer.invoke("ai:getSettings"),

  saveSettings: (patch) => ipcRenderer.invoke("ai:saveSettings", patch),

  extractPdf: (filePath) => ipcRenderer.invoke("ai:extractPdf", filePath),

  stream: (payload) => ipcRenderer.invoke("ai:stream", payload),

  onStreamChunk: (cb) => {

    const handler = (_, data) => cb(data);

    ipcRenderer.on("ai:stream-chunk", handler);

    return () => ipcRenderer.removeListener("ai:stream-chunk", handler);

  },

  onStreamEnd: (cb) => {

    const handler = (_, data) => cb(data);

    ipcRenderer.on("ai:stream-end", handler);

    return () => ipcRenderer.removeListener("ai:stream-end", handler);

  },

  onStreamError: (cb) => {

    const handler = (_, data) => cb(data);

    ipcRenderer.on("ai:stream-error", handler);

    return () => ipcRenderer.removeListener("ai:stream-error", handler);

  },

});


