import * as cp from "child_process";
import Path from "path";
import * as vscode from "vscode";
import { buildDiagnosticCollection, logChannel } from "./extension";
import { getZigPath } from "./zigUtil";



export function zigBuild(): void {
    const editor = vscode.window.activeTextEditor;

    const textDocument = editor.document;
    if (textDocument.languageId !== "zig") {
        return;
    }

    const config = vscode.workspace.getConfiguration("zig");
    const buildOption = config.get<string>("buildOption");
    const processArg: string[] = [buildOption];

    switch (buildOption) {
    case "build":
        break;
    default:
        processArg.push(textDocument.fileName);
        break;
    }

    const extraArgs = config.get<string[]>("buildArgs");
    extraArgs.forEach(element => {
        processArg.push(element);
    });

    const cwd = vscode.workspace.getWorkspaceFolder(editor.document.uri).uri.fsPath;
    const buildPath = getZigPath();

    logChannel.appendLine(`Starting building the current workspace at ${cwd}`);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const childProcess = cp.execFile(buildPath, processArg, { cwd }, (err, stdout, stderr) => {
        logChannel.appendLine(stderr);
        const diagnostics: { [id: string]: vscode.Diagnostic[]; } = {};
        const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

        buildDiagnosticCollection.clear();
        for (let match = regex.exec(stderr); match;
            match = regex.exec(stderr)) {
            let path = match[1].trim();
            try {
                if (!path.includes(cwd)) {
                    path = Path.resolve(cwd, path);
                }
            } catch {
                // 
            }
            const line = parseInt(match[2]) - 1;
            const column = parseInt(match[3]) - 1;
            const type = match[4];
            const message = match[5];

            const severity = type.trim().toLowerCase() === "error" ?
                vscode.DiagnosticSeverity.Error :
                vscode.DiagnosticSeverity.Information;

            const range = new vscode.Range(line, column, line, Infinity);

            if (diagnostics[path] == null) diagnostics[path] = [];
            diagnostics[path].push(new vscode.Diagnostic(range, message, severity));
        }

        for (const path in diagnostics) {
            const diagnostic = diagnostics[path];
            buildDiagnosticCollection.set(vscode.Uri.file(path), diagnostic);
        }
    });
}

