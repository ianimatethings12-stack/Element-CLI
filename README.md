<p align="center">
  <a href="https://github.com/ianimatethings12-stack/Element-CLI">
    <img src="packages/web/src/assets/ocean-logo.png" width="130" alt="Element logo" />
  </a>
</p>
<h1 align="center">Element</h1>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://github.com/ianimatethings12-stack/Element-CLI/discussions"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/element-agent"><img alt="npm" src="https://img.shields.io/npm/v/element-agent?style=flat-square" /></a>
  <a href="https://github.com/ianimatethings12-stack/Element-CLI/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/ianimatethings12-stack/Element-CLI/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![Element Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/ianimatethings12-stack/Element-CLI)

---

### Installation

```bash
# Install script
curl -fsSL https://raw.githubusercontent.com/ianimatethings12-stack/Element-CLI/dev/install | bash

# Package managers
npm install -g element-agent
bun add -g element-agent
pnpm add -g element-agent
yarn global add element-agent
```

> [!TIP]
> Remove versions older than 0.1.x before installing.


#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$ELEMENT_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.element/bin` - Default fallback

```bash
# Examples
ELEMENT_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/ianimatethings12-stack/Element-CLI/dev/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://raw.githubusercontent.com/ianimatethings12-stack/Element-CLI/dev/install | bash
```

### Agents

Element includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://github.com/ianimatethings12-stack/Element-CLI/tree/dev/packages/web/src/content/docs/agents).

### Documentation

For more info on how to configure Element, [**head over to our docs**](https://github.com/ianimatethings12-stack/Element-CLI/tree/dev/packages/web/src/content/docs).

### Contributing

If you're interested in contributing to Element, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on Element

If you maintain a third-party project with "element" in its name, for example "element-dashboard" or "element-mobile", please add a note to your README to clarify that it is not built by the Element team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://github.com/ianimatethings12-stack/Element-CLI/discussions) | [X.com](https://github.com/ianimatethings12-stack/Element-CLI)
