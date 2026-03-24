<p align="center">
  <img src="https://raw.githubusercontent.com/afferlab/afferlab/main/public/readmelogo.svg" width="120" />
</p>

<h1 align="center">AfferLab</h1>

<p align="center">
  Strategy-driven AI workspace with programmable conversations.
</p>

<p align="center">

<img src="https://img.shields.io/github/license/afferlab/afferlab?style=for-the-badge" />
  <a href="https://x.com/afferlab">
    <img src="https://img.shields.io/badge/X-Follow-black?style=for-the-badge&logo=twitter" />
  </a>
  <a href="https://www.reddit.com/user/AfferLab/">
    <img src="https://img.shields.io/badge/Reddit-Profile-FF4500?style=for-the-badge&logo=reddit&logoColor=white" />
  </a>
  <a href="https://www.afferlab.com">
    <img src="https://img.shields.io/badge/Website-Visit-black?style=for-the-badge&logo=google-chrome&logoColor=white" />
  </a>
</p>

<p align="center">
  ⚠️ <i>AfferLab is in early development. Expect breaking changes.</i>
</p>

---

## What is AfferLab

**AfferLab** is a local-first AI workspace where conversations are controlled by **programmable strategies**.

Instead of treating AI as a simple chat interface, AfferLab introduces a **strategy execution layer** that allows developers to control:

- how context is built
- how tools are invoked
- how attachments are ingested
- how models are selected
- how responses are streamed

AfferLab is designed for **developers who want full control over AI workflows.**

---

## Features

- Multi-model AI support (OpenAI, Gemini, Claude, DeepSeek)
- Strategy-driven conversation pipeline
- Programmable context building
- Tool execution framework
- Attachment ingest system
- Streaming responses
- Local-first architecture
- SQLite + vector support
- Electron desktop application

---

## Core Architecture

```text
Strategy Engine
│
├── Context Builder
├── Tool Runtime
├── Model Runner
└── Memory / Attachment Ingest
```

---

## Getting Started

```bash
git clone https://github.com/afferlab/afferlab
pnpm install
pnpm dev
```

---

## Documentation

See [documentation](https://docs.afferlab.com)

---

## Project Status

Early development. APIs and systems may change.

---

## License

MIT