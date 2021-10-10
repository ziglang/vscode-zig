"use strict";

import * as path from "path";
import * as cp from "child_process";
import * as vscode from "vscode";
// This will be treeshaked to only the debounce function
import { debounce } from "lodash-es";

export default class ZigCompilerProvider implements vscode.CodeActionProvider {
  private buildDiagnostics: vscode.DiagnosticCollection;
  private astDiagnostics: vscode.DiagnosticCollection;
  private dirtyChange = new WeakMap<vscode.Uri, boolean>();

  public activate(subscriptions: vscode.Disposable[]) {
    subscriptions.push(this);
    this.buildDiagnostics = vscode.languages.createDiagnosticCollection("zig");
    this.astDiagnostics = vscode.languages.createDiagnosticCollection("zig");

    // vscode.workspace.onDidOpenTextDocument(this.doCompile, this, subscriptions);
    // vscode.workspace.onDidCloseTextDocument(
    //   (textDocument) => {
    //     this.diagnosticCollection.delete(textDocument.uri);
    //   },
    //   null,
    //   subscriptions
    // );

    // vscode.workspace.onDidSaveTextDocument(this.doCompile, this);
    vscode.workspace.onDidChangeTextDocument(
      this.maybeDoASTGenErrorCheck,
      this
    );
  }

  maybeDoASTGenErrorCheck(change: vscode.TextDocumentChangeEvent) {
    if (change.document.languageId !== "zig") return;
    if (change.document.isClosed) {
      this.astDiagnostics.delete(change.document.uri);
    }

    this.doASTGenErrorCheck(change);

    if (!change.document.isUntitled) {
      let config = vscode.workspace.getConfiguration("zig");
      if (
        config.get<boolean>("buildOnSave") &&
        this.dirtyChange.has(change.document.uri) &&
        this.dirtyChange.get(change.document.uri) !== change.document.isDirty &&
        !change.document.isDirty
      ) {
        this.doCompile(change.document);
      }

      this.dirtyChange.set(change.document.uri, change.document.isDirty);
    }
  }

  public dispose(): void {
    this.buildDiagnostics.clear();
    this.astDiagnostics.clear();
    this.buildDiagnostics.dispose();
    this.astDiagnostics.dispose();
  }

  private _doASTGenErrorCheck(change: vscode.TextDocumentChangeEvent) {
    let config = vscode.workspace.getConfiguration("zig");
    const textDocument = change.document;
    if (textDocument.languageId !== "zig") {
      return;
    }
    const zig_path = config.get("zigPath") || "zig";
    const cwd = vscode.workspace.getWorkspaceFolder(textDocument.uri).uri
      .fsPath;

    let childProcess = cp.spawn(zig_path as string, ["ast-check"], { cwd });

    if (!childProcess.pid) {
      return;
    }

    var stderr = "";
    childProcess.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    childProcess.stdin.end(change.document.getText(null));

    childProcess.once("close", () => {
      this.doASTGenErrorCheck.cancel();
      this.astDiagnostics.delete(textDocument.uri);

      if (stderr.length == 0) return;
      var diagnostics: { [id: string]: vscode.Diagnostic[] } = {};
      let regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

      for (let match = regex.exec(stderr); match; match = regex.exec(stderr)) {
        let path = textDocument.uri.fsPath;

        let line = parseInt(match[2]) - 1;
        let column = parseInt(match[3]) - 1;
        let type = match[4];
        let message = match[5];

        let severity =
          type.trim().toLowerCase() === "error"
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Information;
        let range = new vscode.Range(line, column, line, Infinity);

        if (diagnostics[path] == null) diagnostics[path] = [];
        diagnostics[path].push(new vscode.Diagnostic(range, message, severity));
      }

      for (let path in diagnostics) {
        let diagnostic = diagnostics[path];
        this.astDiagnostics.set(textDocument.uri, diagnostic);
      }
    });
  }

  private _doCompile(textDocument: vscode.TextDocument) {
    let config = vscode.workspace.getConfiguration("zig");

    let buildOption = config.get<string>("buildOption");
    let processArg: string[] = [buildOption];
    let workspaceFolder = vscode.workspace.getWorkspaceFolder(textDocument.uri);
    if (!workspaceFolder && vscode.workspace.workspaceFolders.length) {
      workspaceFolder = vscode.workspace.workspaceFolders[0];
    }
    const cwd = workspaceFolder.uri.fsPath;

    switch (buildOption) {
      case "build":
        let buildFilePath = config.get<string>("buildFilePath");
        processArg.push("--build-file");
        try {
          processArg.push(
            path.resolve(buildFilePath.replace("${workspaceFolder}", cwd))
          );
        } catch {}

        break;
      default:
        processArg.push(textDocument.fileName);
        break;
    }

    let extraArgs = config.get<string[]>("buildArgs");
    extraArgs.forEach((element) => {
      processArg.push(element);
    });

    let decoded = "";
    let childProcess = cp.spawn("zig", processArg, { cwd });
    if (childProcess.pid) {
      childProcess.stderr.on("data", (data: Buffer) => {
        decoded += data;
      });
      childProcess.stdout.on("end", () => {
        this.doCompile.cancel();
        var diagnostics: { [id: string]: vscode.Diagnostic[] } = {};
        let regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

        this.buildDiagnostics.clear();
        for (
          let match = regex.exec(decoded);
          match;
          match = regex.exec(decoded)
        ) {
          let path = match[1].trim();
          try {
            if (!path.includes(cwd)) {
              path = require("path").resolve(workspaceFolder.uri.fsPath, path);
            }
          } catch {}

          let line = parseInt(match[2]) - 1;
          let column = parseInt(match[3]) - 1;
          let type = match[4];
          let message = match[5];

          // De-dupe build errors with ast errors
          if (this.astDiagnostics.has(textDocument.uri)) {
            for (let diag of this.astDiagnostics.get(textDocument.uri)) {
              if (
                diag.range.start.line === line &&
                diag.range.start.character === column
              ) {
                continue;
              }
            }
          }

          let severity =
            type.trim().toLowerCase() === "error"
              ? vscode.DiagnosticSeverity.Error
              : vscode.DiagnosticSeverity.Information;
          let range = new vscode.Range(line, column, line, Infinity);

          if (diagnostics[path] == null) diagnostics[path] = [];
          diagnostics[path].push(
            new vscode.Diagnostic(range, message, severity)
          );
        }

        for (let path in diagnostics) {
          let diagnostic = diagnostics[path];
          this.buildDiagnostics.set(vscode.Uri.file(path), diagnostic);
        }
      });
    }
  }

  doASTGenErrorCheck = debounce(this._doASTGenErrorCheck, 16, {
    trailing: true,
  });
  doCompile = debounce(this._doCompile, 60);
  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Command[]> {
    return [];
  }
}
