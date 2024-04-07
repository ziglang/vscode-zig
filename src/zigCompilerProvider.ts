import vscode from "vscode";

import childProcess from "child_process";
import path from "path";

// This will be treeshaked to only the debounce function
import { DebouncedFunc, throttle } from "lodash-es";

import * as zls from "./zls";
import { getZigPath, handleConfigOption } from "./zigUtil";

export default class ZigCompilerProvider {
    private buildDiagnostics!: vscode.DiagnosticCollection;
    private astDiagnostics!: vscode.DiagnosticCollection;
    private dirtyChange = new WeakMap<vscode.Uri, boolean>();

    private doASTGenErrorCheck: DebouncedFunc<(change: vscode.TextDocumentChangeEvent) => void>;
    private doCompile: DebouncedFunc<(textDocument: vscode.TextDocument) => void>;

    constructor() {
        this.doASTGenErrorCheck = throttle(
            (change: vscode.TextDocumentChangeEvent) => {
                this._doASTGenErrorCheck(change);
            },
            16,
            {
                trailing: true,
            },
        );
        this.doCompile = throttle((textDocument: vscode.TextDocument) => {
            this._doCompile(textDocument);
        }, 60);
    }

    public activate(subscriptions: vscode.Disposable[]) {
        this.buildDiagnostics = vscode.languages.createDiagnosticCollection("zig");
        this.astDiagnostics = vscode.languages.createDiagnosticCollection("zig");

        subscriptions.push(
            this.buildDiagnostics,
            this.astDiagnostics,
            vscode.workspace.onDidChangeTextDocument((change) => {
                this.maybeDoASTGenErrorCheck(change);
            }),
            vscode.workspace.onDidSaveTextDocument((change) => {
                this.maybeDoBuildOnSave(change);
            }),
            vscode.commands.registerCommand("zig.build.workspace", () => {
                if (!vscode.window.activeTextEditor) return;
                this.doCompile(vscode.window.activeTextEditor.document);
            }),
        );
    }

    maybeDoASTGenErrorCheck(change: vscode.TextDocumentChangeEvent) {
        if (change.document.languageId !== "zig") {
            return;
        }
        if (zls.client !== null) {
            this.astDiagnostics.clear();
            return;
        }
        if (change.document.isClosed) {
            this.astDiagnostics.delete(change.document.uri);
        }

        this.doASTGenErrorCheck(change);
    }

    maybeDoBuildOnSave(document: vscode.TextDocument) {
        if (document.languageId !== "zig") return;
        if (document.isUntitled) return;

        const config = vscode.workspace.getConfiguration("zig");
        if (
            config.get<boolean>("buildOnSave") &&
            this.dirtyChange.has(document.uri) &&
            this.dirtyChange.get(document.uri) !== document.isDirty &&
            !document.isDirty
        ) {
            this.doCompile(document);
        }

        this.dirtyChange.set(document.uri, document.isDirty);
    }

    private _doASTGenErrorCheck(change: vscode.TextDocumentChangeEvent) {
        const textDocument = change.document;
        if (textDocument.languageId !== "zig") {
            return;
        }
        const zigPath = getZigPath();
        const { error, stderr } = childProcess.spawnSync(zigPath, ["ast-check"], {
            input: textDocument.getText(),
            maxBuffer: 10 * 1024 * 1024, // 10MB
            encoding: "utf8",
            stdio: ["pipe", "ignore", "pipe"],
            timeout: 60000, // 60 seconds (this is a very high value because 'zig ast-check' is just in time compiled)
        });

        if (error ?? stderr.length === 0) return;

        const diagnostics: Record<string, vscode.Diagnostic[] | undefined> = {};
        const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

        for (let match = regex.exec(stderr); match; match = regex.exec(stderr)) {
            const filePath = textDocument.uri.fsPath;

            const line = parseInt(match[2]) - 1;
            const column = parseInt(match[3]) - 1;
            const type = match[4];
            const message = match[5];

            const severity =
                type.trim().toLowerCase() === "error"
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Information;
            const range = new vscode.Range(line, column, line, Infinity);

            const diagnosticArray = diagnostics[filePath] ?? [];
            diagnosticArray.push(new vscode.Diagnostic(range, message, severity));
            diagnostics[filePath] = diagnosticArray;
        }

        for (const filePath in diagnostics) {
            const diagnostic = diagnostics[filePath];
            this.astDiagnostics.set(textDocument.uri, diagnostic);
        }
    }

    private _doCompile(textDocument: vscode.TextDocument) {
        const config = vscode.workspace.getConfiguration("zig");

        const zigPath = getZigPath();

        const buildOption = config.get<string>("buildOption", "build");
        const processArg: string[] = [buildOption];
        let workspaceFolder = vscode.workspace.getWorkspaceFolder(textDocument.uri);
        if (!workspaceFolder && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            workspaceFolder = vscode.workspace.workspaceFolders[0];
        }
        if (!workspaceFolder) return;
        const cwd = workspaceFolder.uri.fsPath;

        switch (buildOption) {
            case "build": {
                const buildFilePath = config.get<string>("buildFilePath");
                if (!buildFilePath) break;
                processArg.push("--build-file");
                try {
                    processArg.push(path.resolve(handleConfigOption(buildFilePath)));
                } catch {
                    //
                }
                break;
            }
            default:
                processArg.push(textDocument.fileName);
                break;
        }

        const extraArgs = config.get<string[]>("buildArgs", []);
        extraArgs.forEach((element) => {
            processArg.push(element);
        });

        let decoded = "";
        const child = childProcess.spawn(zigPath, processArg, { cwd });
        if (child.pid) {
            child.stderr.on("data", (data: string) => {
                decoded += data;
            });
            child.stdout.on("end", () => {
                this.doCompile.cancel();
                const diagnostics: Record<string, vscode.Diagnostic[] | undefined> = {};
                const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

                this.buildDiagnostics.clear();
                for (let match = regex.exec(decoded); match; match = regex.exec(decoded)) {
                    let resolvedPath = match[1].trim();
                    try {
                        if (!resolvedPath.includes(cwd)) {
                            resolvedPath = path.resolve(cwd, resolvedPath);
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
                        for (const diag of this.astDiagnostics.get(textDocument.uri) ?? []) {
                            if (diag.range.start.line === line && diag.range.start.character === column) {
                                continue;
                            }
                        }
                    }

                    const severity =
                        type.trim().toLowerCase() === "error"
                            ? vscode.DiagnosticSeverity.Error
                            : vscode.DiagnosticSeverity.Information;
                    const range = new vscode.Range(line, column, line, Infinity);

                    const diagnosticArray = diagnostics[resolvedPath] ?? [];
                    diagnosticArray.push(new vscode.Diagnostic(range, message, severity));
                    diagnostics[resolvedPath] = diagnosticArray;
                }

                for (const filePath in diagnostics) {
                    const diagnostic = diagnostics[filePath];
                    this.buildDiagnostics.set(vscode.Uri.file(filePath), diagnostic);
                }
            });
        }
    }
}
