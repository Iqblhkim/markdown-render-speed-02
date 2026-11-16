[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Iqblhkim/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Iqblhkim/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

# Faster Markdown renderer

A faster drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3: a dependency-free JavaScript module (`parse.js`) whose `parse(markdown)` returns exactly the HTML marked renders with its default options (GFM on).

- **Correctness: 720/720 cases** — every CommonMark 0.31.2 and GFM 0.29 spec example, plus 40 generated READMEs, byte-for-byte identical to marked.
- **Speed: ~1.20× faster than marked** (median of 5 stable runs; 1.15×–1.27×), measured on CPU time.
- Pure JavaScript, no dependencies, no network, deterministic.

Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty ($250).

[https://make.fun/bounty/markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02)
