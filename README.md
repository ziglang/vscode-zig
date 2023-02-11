# vscode-zig

[![VSCode Extension](https://img.shields.io/badge/vscode-extension-brightgreen)](https://marketplace.visualstudio.com/items?itemName=ziglang.zig)
[![CI](https://github.com/ziglang/vscode-zig/workflows/CI/badge.svg)](https://github.com/ziglang/vscode-zig/actions)

[Zig](http://ziglang.org/) support for Visual Studio Code.

![Syntax Highlighting, Code Completion](./images/example.png)

## Features

- syntax highlighting
- basic compiler linting
- automatic formatting
- optional [Zig Language Server](https://github.com/zigtools/zls) features
  - completions
  - goto definition/declaration
  - document symbols
  - ... and [many more](https://github.com/zigtools/zls#features)

## Automatic Formatting

To enable automatic formatting add the `zig` command to your `PATH`, or
modify the `Zig Path` setting to point to the `zig` binary.

## Creating .vsix extension file

```
npm install
npm run compile
npx vsce package
```
