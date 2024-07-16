import vscode from "vscode";

import childProcess from "child_process";

import { getZigPath } from "./zigUtil";

const ZIG_MODE: vscode.DocumentSelector = { language: "zig" };

export function registerDocumentFormatting(): vscode.Disposable {
    let registeredFormatter: vscode.Disposable | null = null;

    const onformattingProviderChange = () => {
        if (vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") === "off") {
            // Unregister the formatting provider
            if (registeredFormatter !== null) registeredFormatter.dispose();
            registeredFormatter = null;
        } else {
            // register the formatting provider
            registeredFormatter ??= vscode.languages.registerDocumentRangeFormattingEditProvider(
                ZIG_MODE,
                new ZigFormatProvider(),
            );
        }
    };

    onformattingProviderChange();
    const registeredDidChangeEvent = vscode.workspace.onDidChangeConfiguration(onformattingProviderChange);

    return {
        dispose: () => {
            registeredDidChangeEvent.dispose();
            if (registeredFormatter !== null) registeredFormatter.dispose();
        },
    };
}

export class ZigFormatProvider implements vscode.DocumentRangeFormattingEditProvider {
    provideDocumentRangeFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[] | null> {
        return Promise.resolve(zigFormat(document));
    }
}

function zigFormat(document: vscode.TextDocument): vscode.TextEdit[] | null {
    const zigPath = getZigPath();

    const stdout = childProcess.execFileSync(zigPath, ["fmt", "--stdin"], {
        input: document.getText(),
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: "utf8",
        timeout: 60000, // 60 seconds (this is a very high value because 'zig fmt' is just in time compiled)
    });

    if (stdout.length === 0) return null;
    const lastLineId = document.lineCount - 1;
    const wholeDocument = new vscode.Range(0, 0, lastLineId, document.lineAt(lastLineId).text.length);
    return [new vscode.TextEdit(wholeDocument, stdout)];
}
