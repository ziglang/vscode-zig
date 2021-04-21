'use strict';

import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';

export default class ZigCompilerProvider implements vscode.CodeActionProvider {
    private diagnosticCollection: vscode.DiagnosticCollection;

    public activate(subscriptions: vscode.Disposable[]) {
        subscriptions.push(this);
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection("zig");

        vscode.workspace.onDidOpenTextDocument(this.doCompile, this, subscriptions);
        vscode.workspace.onDidCloseTextDocument((textDocument) => {
            this.diagnosticCollection.delete(textDocument.uri);
        }, null, subscriptions);

        vscode.workspace.onDidSaveTextDocument(this.doCompile, this);
    }

    public dispose(): void {
        this.diagnosticCollection.clear();
        this.diagnosticCollection.dispose();
    }

    private doCompile(textDocument: vscode.TextDocument) {
        let config = vscode.workspace.getConfiguration('zig');
        let buildOnSave = config.get<boolean>("buildOnSave");

        if (textDocument.languageId !== 'zig' || buildOnSave !== true) {
            return;
        }

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
                processArg.push(buildFilePath.replace("${workspaceFolder}", cwd));
                break;
            default:
                processArg.push(textDocument.fileName);
                break;
        }

        let extraArgs = config.get<string[]>("buildArgs");
        extraArgs.forEach(element => {
            processArg.push(element);
        });

        let decoded = ''
        let childProcess = cp.spawn('zig', processArg, undefined);
        if (childProcess.pid) {
            childProcess.stderr.on('data', (data: Buffer) => {
                decoded += data;
            });
            childProcess.stdout.on('end', () => {
                var diagnostics: { [id: string]: vscode.Diagnostic[]; } = {};
                let regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

                this.diagnosticCollection.clear();
                for (let match = regex.exec(decoded); match;
                    match = regex.exec(decoded)) {
                    let path = match[1].trim();
                    if (!path.includes(cwd)) {
                        path = vscode.Uri.joinPath(workspaceFolder.uri, path).fsPath;
                    }

                    let line = parseInt(match[2]) - 1;
                    let column = parseInt(match[3]) - 1;
                    let type = match[4];
                    let message = match[5];

                    let severity = type.trim().toLowerCase() === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information;
                    let range = new vscode.Range(line, column,
                        line, column + 1);

                    if (diagnostics[path] == null) diagnostics[path] = [];
                    diagnostics[path].push(new vscode.Diagnostic(range, message, severity));
                }

                for (let path in diagnostics) {
                    let diagnostic = diagnostics[path];
                    this.diagnosticCollection.set(vscode.Uri.file(path), diagnostic);
                }
            });
        }
    }

    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Command[]> {
        return [];
    }
}
