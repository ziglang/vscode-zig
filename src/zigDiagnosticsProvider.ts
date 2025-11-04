import vscode from "vscode";

import childProcess from "child_process";
import path from "path";

// This will be treeshaked to only the debounce function
import { throttle } from "lodash-es";

import * as semver from "semver";
import * as zls from "./zls";
import { zigProvider } from "./zigSetup";

export function registerDiagnosticsProvider(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    const diagnosticCollection = vscode.languages.createDiagnosticCollection("zig");
    disposables.push(diagnosticCollection);

    const throttledCollectAstCheckDiagnostics = throttle(collectAstCheckDiagnostics, 16, { trailing: true });

    vscode.workspace.onDidChangeTextDocument((change) => {
        if (change.document.languageId !== "zig") {
            return;
        }
        if (zls.client !== null) {
            diagnosticCollection.clear();
            return;
        }
        if (change.document.isClosed) {
            diagnosticCollection.delete(change.document.uri);
        }

        throttledCollectAstCheckDiagnostics(diagnosticCollection, change.document);
    }, disposables);

    return {
        dispose: () => {
            for (const disposable of disposables) {
                disposable.dispose();
            }
        },
    };
}

function collectAstCheckDiagnostics(
    diagnosticCollection: vscode.DiagnosticCollection,
    textDocument: vscode.TextDocument,
): void {
    const zigPath = zigProvider.getZigPath();
    const zigVersion = zigProvider.getZigVersion();
    if (!zigPath || !zigVersion) return;

    const args = ["ast-check"];

    const addedZonSupportVersion = new semver.SemVer("0.14.0-dev.2508+7e8be2136");
    if (path.extname(textDocument.fileName) === ".zon" && semver.gte(zigVersion, addedZonSupportVersion)) {
        args.push("--zon");
    }

    const { error, stderr } = childProcess.spawnSync(zigPath, args, {
        input: textDocument.getText(),
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: "utf8",
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 5000, // 5 seconds
    });

    if (error ?? stderr.length === 0) {
        diagnosticCollection.delete(textDocument.uri);
        return;
    }

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
        diagnosticCollection.set(textDocument.uri, diagnostic);
    }
}
