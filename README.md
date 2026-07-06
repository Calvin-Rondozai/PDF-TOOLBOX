# Hello C

Modern desktop PDF reader and toolkit built with **Electron** + **Python (PyMuPDF)**.
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/4c0538e1-7071-4e5e-8e44-5323e5beffec" />


## Features

- **Viewer** — continuous scroll, zoom, page navigation, drag & drop
- **Search** — find text across pages
- **Merge** — combine multiple PDFs
- **PDF Tools** — compress (target size / standard), resize pages
- **File Ops** — split, extract range, rotate, watermark, password protect
- **Audio** — read aloud (browser TTS), export audio (Python pyttsx3)

## Setup (one-time)

### 1. Python backend

```bash
pip install -r requirements.txt
```

### 2. Electron app

```bash
npm install
```

## Run

```bash
npm start
```

Or use the original PyQt app:

```bash
python app.py
```

## Test PDF operations

```bash
npm run test:python
```

## Project structure

```
PDF Tool/
├── app.py              # Original PyQt6 app
├── electron/           # Electron main + preload
├── renderer/           # Modern UI (HTML/CSS/JS)
├── python/
│   ├── pdf_engine.py   # Shared PDF backend
│   ├── pdf_cli.py      # CLI for Electron IPC
│   └── test_engine.py  # Integration tests
├── package.json
└── requirements.txt



```
