"use strict";

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
// This will be treeshaked to only the debounce function
import { throttle } from "lodash-es";
import Path from "path";
import { getZigPath } from "./zigUtil";

export default class ZigCompilerProvider implements vscode.CodeActionProvider {
    private buildDiagnostics: vscode.DiagnosticCollection;
    private astDiagnostics: vscode.DiagnosticCollection;
    private dirtyChange = new WeakMap<vscode.Uri, boolean>();

    public activate(subscriptions: vscode.Disposable[]) {
        subscriptions.push(this);
        this.buildDiagnostics = vscode.languages.createDiagnosticCollection("zig");
        this.astDiagnostics = vscode.languages.createDiagnosticCollection("zig");

        vscode.workspace.onDidChangeTextDocument(this.maybeDoASTGenErrorCheck, this);
        vscode.workspace.onDidChangeTextDocument(this.maybeDoBuildOnSave, this);

        subscriptions.push(vscode.commands.registerCommand("zig.build.workspace", () => this.doCompile(vscode.window.activeTextEditor.document)));
    }

    maybeDoASTGenErrorCheck(change: vscode.TextDocumentChangeEvent) {
        if (change.document.languageId !== "zig") {return;}
        if (vscode.workspace.getConfiguration("zig").get<string>("astCheckProvider") !== "extension") {
            this.astDiagnostics.clear();
            return;
        }
        if (change.document.isClosed) {
            this.astDiagnostics.delete(change.document.uri);
        }

        this.doASTGenErrorCheck(change);
    }

    maybeDoBuildOnSave(change: vscode.TextDocumentChangeEvent) {
        if (change.document.languageId !== "zig") {return;}
        if (change.document.isUntitled) {return;}

        const config = vscode.workspace.getConfiguration("zig");
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

    public dispose(): void {
        this.buildDiagnostics.clear();
        this.astDiagnostics.clear();
        this.buildDiagnostics.dispose();
        this.astDiagnostics.dispose();
    }

    private _doASTGenErrorCheck(change: vscode.TextDocumentChangeEvent) {
        const textDocument = change.document;
        if (textDocument.languageId !== "zig") {
            return;
        }
        const zigPath = getZigPath();
        const cwd = vscode.workspace.getWorkspaceFolder(textDocument.uri).uri
            .fsPath;

        const childProcess = cp.spawn(zigPath, ["ast-check"], { cwd });

        if (!childProcess.pid) {
            return;
        }

        let stderr = "";
        childProcess.stderr.on("data", (chunk) => {
            stderr += chunk;
        });

        childProcess.stdin.end(change.document.getText(null));

        childProcess.once("close", () => {
            this.doASTGenErrorCheck.cancel();
            this.astDiagnostics.delete(textDocument.uri);

            if (stderr.length === 0) {return;}
            const diagnostics: { [id: string]: vscode.Diagnostic[] } = {};
            const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

            for (let match = regex.exec(stderr); match; match = regex.exec(stderr)) {
                const path = textDocument.uri.fsPath;

                const line = parseInt(match[2]) - 1;
                const column = parseInt(match[3]) - 1;
                const type = match[4];
                const message = match[5];

                const severity =
          type.trim().toLowerCase() === "error"
              ? vscode.DiagnosticSeverity.Error
              : vscode.DiagnosticSeverity.Information;
                const range = new vscode.Range(line, column, line, Infinity);

                if (!diagnostics[path]) {diagnostics[path] = [];}
                diagnostics[path].push(new vscode.Diagnostic(range, message, severity));
            }

            for (const path in diagnostics) {
                const diagnostic = diagnostics[path];
                this.astDiagnostics.set(textDocument.uri, diagnostic);
            }
        });
    }

    private _doCompile(textDocument: vscode.TextDocument) {
        const config = vscode.workspace.getConfiguration("zig");

        const buildOption = config.get<string>("buildOption");
        const processArg: string[] = [buildOption];
        let workspaceFolder = vscode.workspace.getWorkspaceFolder(textDocument.uri);
        if (!workspaceFolder && vscode.workspace.workspaceFolders.length) {
            workspaceFolder = vscode.workspace.workspaceFolders[0];
        }
        const cwd = workspaceFolder.uri.fsPath;

        switch (buildOption) {
        case "build":{
            const buildFilePath = config.get<string>("buildFilePath");
            processArg.push("--build-file");
            try {
                processArg.push(
                    path.resolve(buildFilePath.replace("${workspaceFolder}", cwd))
                );
            } catch {
                // 
            }
            break;
        }
        default:
            processArg.push(textDocument.fileName);
            break;
        }

        const extraArgs = config.get<string[]>("buildArgs");
        extraArgs.forEach((element) => {
            processArg.push(element);
        });

        let decoded = "";
        const childProcess = cp.spawn("zig", processArg, { cwd });
        if (childProcess.pid) {
            childProcess.stderr.on("data", (data: Buffer) => {
                decoded += data;
            });
            childProcess.stdout.on("end", () => {
                this.doCompile.cancel();
                const diagnostics: { [id: string]: vscode.Diagnostic[] } = {};
                const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

                this.buildDiagnostics.clear();
                for (
                    let match = regex.exec(decoded);
                    match;
                    match = regex.exec(decoded)
                ) {
                    let path = match[1].trim();
                    try {
                        if (!path.includes(cwd)) {
                            path = Path.resolve(workspaceFolder.uri.fsPath, path);
                        }
                    } catch {
                        // 
                    }

                    const line = parseInt(match[2]) - 1;
                    const column = parseInt(match[3]) - 1;
                    const type = match[4];
                    const message = match[5];

                    // De-dupe build errors with ast errors
                    if (this.astDiagnostics.has(textDocument.uri)) {
                        for (const diag of this.astDiagnostics.get(textDocument.uri)) {
                            if (
                                diag.range.start.line === line &&
                diag.range.start.character === column
                            ) {
                                continue;
                            }
                        }
                    }

                    const severity =
            type.trim().toLowerCase() === "error"
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Information;
                    const range = new vscode.Range(line, column, line, Infinity);

                    if (!diagnostics[path]) {diagnostics[path] = [];}
                    diagnostics[path].push(
                        new vscode.Diagnostic(range, message, severity)
                    );
                }

                for (const path in diagnostics) {
                    const diagnostic = diagnostics[path];
                    this.buildDiagnostics.set(vscode.Uri.file(path), diagnostic);
                }
            });
        }
    }

    doASTGenErrorCheck = throttle(this._doASTGenErrorCheck, 16, {
        trailing: true,
    });
    doCompile = throttle(this._doCompile, 60);
    public provideCodeActions(): vscode.ProviderResult<vscode.Command[]> {
        return [];
    }
}
