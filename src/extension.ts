"use strict";
import * as vscode from "vscode";
import ZigCompilerProvider from "./zigCompilerProvider";
import { zigBuild } from "./zigBuild";
import { ZigFormatProvider, ZigRangeFormatProvider } from "./zigFormat";
import * as child_process from "child_process";
import { CodelensProvider } from "./zigCodeLensProvider";
import path from "path";
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

    task.presentationOptions.clear = true;
    task.presentationOptions.reveal = vscode.TaskRevealKind.Always;
    task.presentationOptions.showReuseMessage = false;

    const workspaceFolder = task.scope as vscode.WorkspaceFolder;
    const filename = task.definition.file as vscode.Uri;
    const filter = task.definition.filter as string;
    const config = vscode.workspace.getConfiguration("zig");
    const bin = (config.get("zigPath") as string) || "zig";

    const testOptions = (task.definition.args as string) || "";
    var main_package_path = "";
    try {
      main_package_path = path.resolve(workspaceFolder.uri.fsPath, "build.zig");
    } catch {}
    const args = [
      bin,
      "test",
      main_package_path.length &&
        `--main-pkg-path ${workspaceFolder.uri.fsPath}`,
      filename && path.relative(workspaceFolder.uri.fsPath, filename.fsPath),
      filter && filter.length > 0 && `--test-filter ${filter}`,
      testOptions,
    ].filter((a) => Boolean(a));

    task.problemMatchers = !config.get("disableProblemMatcherForTest")
      ? ["zig"]
      : [];
    task.execution = new vscode.ShellExecution(args.join(" "), {});

    return task;
  };

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider("zig", {
      provideTasks: (token) => {
        return [
          new vscode.Task(
            { type: "zig test", task: "zig test" },
            vscode.workspace.workspaceFolders[0],
            "zig test",
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
          { type: "zig test", task: "test" },
          vscode.workspace.workspaceFolders[0],
          "zig test",
          "zig",
          new vscode.ShellExecution("zig test")
        );
        task.detail = "zig test";

        const config = vscode.workspace.getConfiguration("zig");

        task.definition.file = filename;
        task.definition.filter = filter;
        task.definition.args = config.get("testArgs") || "";
        vscode.tasks.executeTask(resolveTask(task, null));
      }
    )
  );
}

export function deactivate() {}
