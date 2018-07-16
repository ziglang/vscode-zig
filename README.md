# vscode-zig

[Zig](http://ziglang.org/) support for Visual Studio Code.

![Syntax Highlighting](./images/example.png)

## Features

 - syntax highlighting
 - basic compiler linting
 - automatic formatting

## Automatic Formatting

To enable automatic formatting, the `zig.formatCommand` property must be
configured in your settings. This should be the command to run `zig fmt`, which
can is found on the current [stage2
compiler](https://github.com/ziglang/zig#stage-2-build-self-hosted-zig-from-zig-source-code).
