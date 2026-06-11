const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const ai = require("./ai-service");
const { runPythonOp } = require("./python-bridge");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#f4f6f9",
    title: "Hello C — PDF Tool",
    icon: path.join(__dirname, "..", "renderer", "images", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    autoHideMenuBar: true,
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("dialog:openPdf", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Open PDF",
    filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    properties: ["openFile"],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("dialog:openPdfs", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Select PDFs to merge",
    filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    properties: ["openFile", "multiSelections"],
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle("dialog:savePdf", async (_, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Save PDF",
    defaultPath: defaultName || "output.pdf",
    filters: [{ name: "PDF Files", extensions: ["pdf"] }],
  });
  return canceled ? null : filePath;
});

ipcMain.handle("dialog:saveAudio", async (_, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Save Audio",
    defaultPath: defaultName || "audio.mp3",
    filters: [
      { name: "MP3 Audio", extensions: ["mp3"] },
      { name: "WAV Audio", extensions: ["wav"] },
    ],
  });
  return canceled ? null : filePath;
});

ipcMain.handle("dialog:pickFolder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Choose output folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("dialog:openOffice", async (_, kind) => {
  const filters = {
    word: [{ name: "Word Documents", extensions: ["doc", "docx", "odt"] }],
    excel: [{ name: "Excel Spreadsheets", extensions: ["xls", "xlsx", "ods", "csv"] }],
    powerpoint: [{ name: "PowerPoint", extensions: ["ppt", "pptx", "odp"] }],
  };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Select file to convert",
    filters: filters[kind] || filters.word,
    properties: ["openFile"],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("dialog:openImages", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Select images",
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif"] }],
    properties: ["openFile", "multiSelections"],
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle("dialog:saveFile", async (_, defaultName, extensions) => {
  const exts = Array.isArray(extensions) ? extensions : [extensions || "pdf"];
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Save file",
    defaultPath: defaultName,
    filters: [{ name: "File", extensions: exts }],
  });
  return canceled ? null : filePath;
});

ipcMain.handle("fs:readFile", async (_, filePath) => {
  const data = fs.readFileSync(filePath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle("fs:writeFile", async (_, filePath, data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(filePath, buf);
  return true;
});

ipcMain.handle("fs:stat", async (_, filePath) => {
  const st = fs.statSync(filePath);
  return { size: st.size, name: path.basename(filePath) };
});

ipcMain.handle("fs:basename", (_, filePath) => path.basename(filePath));
ipcMain.handle("fs:dirname", (_, filePath) => path.dirname(filePath));
ipcMain.handle("fs:extname", (_, filePath) => path.extname(filePath));

ipcMain.handle("shell:showItemInFolder", (_, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle("pdf:run", async (event, payload) => {
  const sendProgress = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pdf:progress", msg);
    }
  };
  return runPythonOp(payload, sendProgress);
});

ipcMain.handle("pdf:ping", async () => {
  try {
    return await runPythonOp({ op: "ping" });
  } catch (e) {
    return { ok: false, detail: e.message };
  }
});

ipcMain.handle("ai:getSettings", () => ai.getAiSettings());

ipcMain.handle("ai:saveSettings", (_, patch) => {
  try {
    return { ok: true, settings: ai.saveAiSettings(patch) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("ai:extractPdf", async (_, filePath) => {
  try {
    const data = await ai.extractPdf(filePath);
    return {
      ok: true,
      text: ai.trimDocumentText(data.text),
      numpages: data.numpages,
      info: data.info,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("ai:stream", async (event, { messages, temperature }) => {
  try {
    const full = await ai.streamCompletion(event.sender, {
      messages: ai.sanitizeMessages(messages),
      temperature: typeof temperature === "number" ? temperature : undefined,
    });
    return { ok: true, full: String(full) };
  } catch (e) {
    const msg = String(e.message || e);
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send("ai:stream-error", { message: msg });
    }
    return { ok: false, error: msg };
  }
});
