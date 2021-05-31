# vscode-zig

![CI](https://img.shields.io/github/workflow/status/ziglang/vscode-zig/CI.svg)

[Zig](http://ziglang.org/) support for Visual Studio Code.

![Syntax Highlighting](./images/example.png)

## Features

 - syntax highlighting
 - basic compiler linting
 - automatic formatting

## Automatic Formatting

To enable automatic formatting add the `zig` command to your `PATH`, or
modify the `Zig Path` setting to point to the `zig` binary.

## Creating .vsix extension file

```
npm install
tsc src/extension.ts
npx vsce package
```
