const { spawn } = require("child_process");
const path = require("path");

function getPythonCmd() {
  return process.platform === "win32" ? "python" : "python3";
}

function runPythonOp(payload, onProgress) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(__dirname, "..", "python", "pdf_cli.py");
    const proc = spawn(getPythonCmd(), [cliPath], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });

    let stdout = "";
    let buffer = "";

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "progress" && onProgress) {
            onProgress(msg);
          } else if (msg.type === "result") {
            stdout = line;
          }
        } catch {
          /* ignore partial json */
        }
      }
    });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer);
          if (msg.type === "result") stdout = buffer;
        } catch {
          /* ignore */
        }
      }
      if (!stdout) {
        reject(new Error(code === 0 ? "No response from Python backend" : `Python exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

module.exports = { runPythonOp };
