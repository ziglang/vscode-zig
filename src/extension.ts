"use strict";
import fs from "fs";
import YAML from "js-yaml";
import path from "path";
import * as vscode from "vscode";
import { zigBuild } from "./zigBuild";
import { CodelensProvider } from "./zigCodeLensProvider";
import ZigCompilerProvider from "./zigCompilerProvider";
import { ZigFormatProvider, ZigRangeFormatProvider } from "./zigFormat";
const ZIG_MODE: vscode.DocumentFilter = { language: "zig", scheme: "file" };

export let buildDiagnosticCollection: vscode.DiagnosticCollection;
export const logChannel = vscode.window.createOutputChannel("zig");
export let terminal: vscode.Terminal;
export const zigFormatStatusBar = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Left
);

export function activate(context: vscode.ExtensionContext) {
  let compiler = new ZigCompilerProvider();
  let codeLens = new CodelensProvider();
  compiler.activate(context.subscriptions);

  const select: vscode.DocumentSelector = {
    language: "zig",
    scheme: "file",
  };
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(select, compiler)
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(select, codeLens)
  );

  context.subscriptions.push(logChannel);
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      ZIG_MODE,
      new ZigFormatProvider(logChannel)
    )
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      ZIG_MODE,
      new ZigRangeFormatProvider(logChannel)
    )
  );

  buildDiagnosticCollection =
    vscode.languages.createDiagnosticCollection("zig");
  context.subscriptions.push(buildDiagnosticCollection);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("zig.build.workspace", () => zigBuild())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("zig.format.file", () =>
      console.log("test")
    )
  );

  const resolveTask = function resolveTask(task: vscode.Task, token) {
    if (!task.presentationOptions) {
      task.presentationOptions = {};
    }

    const isDebug = task.definition.task === "debug";

    task.presentationOptions.clear = true;
    if (typeof task.presentationOptions.reveal === "undefined") {
      task.presentationOptions.reveal = isDebug
        ? vscode.TaskRevealKind.Silent
        : vscode.TaskRevealKind.Always;
    }

    task.presentationOptions.showReuseMessage = false;
    task.presentationOptions.echo = true;

    const workspaceFolder = task.scope as vscode.WorkspaceFolder;

    const filename = task.definition.file as vscode.Uri;
    const filter = task.definition.filter as string;
    const config = vscode.workspace.getConfiguration("zig");
    const bin = (config.get("zigPath") as string) || "zig";
    const testCmd = (
      (config.get(isDebug ? "beforeDebugCmd" : "testCmd") as string) || ""
    )
      .split(" ")
      .filter(Boolean);

    let femitBinPath = (task.definition.bin || "") as string;

    if (!femitBinPath || femitBinPath.trim().length === 0) {
      const tmpdir = process.env.TMPDIR || config.get("tmpdir") || "/tmp";

      femitBinPath = path.join(
        tmpdir,
        `test-${path.basename(workspaceFolder.uri.fsPath)}`
      );

      femitBinPath = path.resolve(femitBinPath);
    }

    // delete the old bin so know if the test failed to build
    // its okay if it doesn't exist though
    try {
      if (femitBinPath) fs.rmSync(femitBinPath);
    } catch (exception) {}

    const relativeFilename =
      filename && path.relative(workspaceFolder.uri.fsPath, filename.fsPath);
    if (testCmd && testCmd.length > 0) {
      for (let i = 0; i < testCmd.length; i++) {
        if (testCmd[i] === "${filename}") {
          if (relativeFilename) {
            testCmd[i] = relativeFilename;
          } else {
            testCmd.splice(i, 1);
          }
        }

        if (testCmd[i] === "${filter}") {
          if (filter && filter.length > 0) {
            testCmd[i] = filter;
          } else {
            testCmd.splice(i, 1);
          }
        }

        if (testCmd[i] === "${bin}") {
          if (femitBinPath && femitBinPath.length > 0) {
            testCmd[i] = femitBinPath;
          } else {
            testCmd.splice(i, 1);
          }
        }
      }
    }

    const testOptions = (task.definition.args as string) || "";

    let joined = "";

    if (testCmd && testCmd.length > 0) {
      joined = testCmd.filter(Boolean).join(" ");
    } else {
      var main_package_path = "";

      if (!joined.includes("-femit-bin="))
        joined += ` -femit-bin=${femitBinPath} `;
      else {
        let binI = joined.indexOf("-femit-bin") + "-femit-bin".length;
        if (joined[binI] === '"') binI++;
        const end = joined.indexOf(" ", binI);
        femitBinPath = joined.substring(binI, end);
        if (femitBinPath.endsWith('"'))
          femitBinPath = femitBinPath.substring(0, femitBinPath.length - 1);
        if (
          femitBinPath.length === 0 ||
          femitBinPath === "/" ||
          femitBinPath === "." ||
          femitBinPath === "/dev" ||
          femitBinPath === "C:\\" ||
          femitBinPath === "C:\\Windows"
        ) {
          femitBinPath = null;
        }
      }

      try {
        main_package_path = path.resolve(
          workspaceFolder.uri.fsPath,
          "build.zig"
        );
      } catch {}

      const args = [
        bin,
        "test",
        main_package_path.length &&
          `--main-pkg-path ${workspaceFolder.uri.fsPath}`,
        ,
        relativeFilename,
        ...getObjectFiles(filename),
        filter && filter.length > 0 && `--test-filter ${filter}`,
        testOptions,
      ].filter((a) => Boolean(a));

      joined = args.join(" ");

      if (isDebug) {
        if (!joined.includes("--test-no-exec")) joined += `--test-no-exec `;
      }
    }

    task.problemMatchers = !config.get("disableProblemMatcherForTest")
      ? ["zig"]
      : [];
    task.execution = new vscode.ShellExecution(joined, {});

    return task;
  };

  function getObjectFiles(filename: vscode.Uri): string[] {
    const contents = fs.readFileSync(filename.fsPath, "utf8");
    var i = 0;
    const objectFiles = [];

    return objectFiles;
  }
  var lastTestCommand;

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider("zig", {
      provideTasks: (token) => {
        return [
          new vscode.Task(
            { type: "zig", task: "test" },
            vscode.workspace.workspaceFolders[0],
            "test",
            "zig",
            new vscode.ShellExecution("zig test")
          ),
          new vscode.Task(
            { type: "zig", task: "debug" },
            vscode.workspace.workspaceFolders[0],
            "debug",
            "zig",
            new vscode.ShellExecution("zig test")
          ),
        ];
      },
      resolveTask,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "zig.test.run",
      (filename: vscode.Uri, filter: string) => {
        const task = new vscode.Task(
          { type: "zig", task: "test" },
          vscode.workspace.workspaceFolders[0],
          "test",
          "zig",
          new vscode.ShellExecution("zig test")
        );
        task.detail = "zig test";

        const config = vscode.workspace.getConfiguration("zig");

        task.definition.file = filename;

        task.definition.filter = filter;
        task.definition.args = (config.get("testArgs") || "").replace(
          /\$\{workspaceFolder\}/gm,
          vscode.workspace.workspaceFolders[0].uri.fsPath
        );
        lastTestCommand = { filename, filter };
        const resolved = resolveTask(task, null);
        vscode.tasks.executeTask(resolved);
        vscode.commands.executeCommand(
          "setContext",
          "zig.hasLastTestCommand",
          true
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zig.test.rerun", (cmd) => {
      if (lastTestCommand) {
        vscode.commands.executeCommand(
          "zig.test.run",
          lastTestCommand.filename,
          lastTestCommand.filter
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zig.test.rerun.debug", (cmd) => {
      if (lastTestCommand) {
        vscode.commands.executeCommand(
          "zig.test.debug",
          lastTestCommand.filename,
          lastTestCommand.filter
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "zig.test.debug",
      (filename: vscode.Uri, filter: string) => {
        lastTestCommand = { filename, filter };
        const config = vscode.workspace.getConfiguration("zig");

        const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;

        const vscodeDebuggerExtension = vscode.extensions.getExtension(
          "vadimcn.vscode-lldb"
        );

        if (!vscodeDebuggerExtension) {
          logChannel.appendLine(
            "vscode-lldb extension is not installed.\nTo enable debugging, please install https://github.com/vadimcn/vscode-lldb."
          );
          logChannel.show();
          return;
        }

        if (!vscodeDebuggerExtension.isActive) {
          logChannel.appendLine(
            "vscode-lldb extension is not enabled.\nTo enable debugging, please enable vscode-lldb."
          );
          logChannel.show();
          return;
        }

        logChannel.clear();

        const tmpdir = process.env.TMPDIR || config.get("tmpdir") || "/tmp";

        let femitBinPath = path.join(
          tmpdir,
          `test-${path.basename(
            vscode.workspace.workspaceFolders[0].uri.fsPath
          )}`
        );

        // delete the old bin so know if the test failed to build
        // its okay if it doesn't exist though
        try {
          fs.rmSync(femitBinPath);
          femitBinPath = path.resolve(femitBinPath);
        } catch (exception) {}

        const task = resolveTask(
          new vscode.Task(
            {
              type: "zig",
              task: "debug",
              filter,
              file: filename,
              bin: femitBinPath,
            },
            vscode.workspace.workspaceFolders[0],
            "debug",
            "zig",
            new vscode.ShellExecution("zig test")
          ),
          undefined
        );

        var handler = vscode.tasks.onDidEndTask((event) => {
          if (event.execution.task.name !== "debug") return;
          handler.dispose();
          handler = null;
          if (!fs.existsSync(femitBinPath)) {
            return;
          }

          const launch = Object.assign(
            {},
            {
              type: "lldb",
              request: "launch",
              name: "Zig Debug",
              program: femitBinPath,
              args:
                Array.isArray(config.get("debugArgs")) &&
                config.get("debugArgs").length > 0
                  ? config.get("debugArgs")
                  : ["placeholderBecauseZigTestCrashesWithoutArgs"],
              cwd: workspaceFolder,
              internalConsoleOptions: "openOnSessionStart",
              terminal: "console",
            }
          );

          var yaml = YAML.dump(launch, {
            condenseFlow: true,
            forceQuotes: true,
          });

          if (yaml.endsWith(",")) {
            yaml = yaml.substring(0, yaml.length - 1);
          }

          return vscode.env
            .openExternal(
              vscode.Uri.parse(
                `${vscode.env.uriScheme}://vadimcn.vscode-lldb/launch/config?${yaml}`
              )
            )
            .then((a) => {});
        });
        vscode.tasks.executeTask(task).then(() => {});
      }
    )
  );
}

export function deactivate() {}
