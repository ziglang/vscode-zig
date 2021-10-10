"use strict";
import * as vscode from "vscode";
import ZigCompilerProvider from "./zigCompilerProvider";
import { zigBuild } from "./zigBuild";
import { ZigFormatProvider, ZigRangeFormatProvider } from "./zigFormat";
import * as child_process from "child_process";
import { CodelensProvider } from "./zigCodeLensProvider";
import path from "path";
import fs from "fs";

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

  const resolveTask = function resolveTask(
    task: vscode.Task,
    token,
    additionalArgs = []
  ) {
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
      ...additionalArgs,
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

        const contents = fs.readFileSync(filename.fsPath, "utf8");
        var i = 0;
        const objectFiles = [];
        while (i < contents.length) {
          const linkStart = contents.indexOf('// @link "', i);
          if (linkStart === -1) {
            break;
          }
          i += '// @link "'.length;
          const startQuote = i;
          const lineEnd = contents.indexOf("\n", i);
          if (lineEnd === -1) break;

          const endQuote = contents.indexOf('"', i);
          if (endQuote === -1 || endQuote > lineEnd) {
            logChannel.appendLine(
              `@link ignored due to missing quote (position: ${startQuote})`
            );
            logChannel.show();
            break;
          }
          i = lineEnd + 1;

          const filepath = contents.substring(startQuote, endQuote);
          try {
            const out = path.resolve(path.dirname(filename.fsPath), filepath);

            objectFiles.push(`"${out}"`);
          } catch (exception) {
            logChannel.appendLine(
              `Could not resolve ${filepath} relative to ${
                filename.fsPath
              } due to error:\n${exception.toString()}`
            );
            logChannel.show();
          }
        }

        const config = vscode.workspace.getConfiguration("zig");

        task.definition.file = filename;
        task.definition.filter = filter;
        task.definition.args = config.get("testArgs") || "";

        vscode.tasks.executeTask(resolveTask(task, null, objectFiles));
      }
    )
  );
}

export function deactivate() {}
