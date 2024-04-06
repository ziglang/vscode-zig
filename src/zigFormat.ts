import vscode from "vscode";

import childProcess from "child_process";

import { getZigPath } from "./zigUtil";

export class ZigFormatProvider implements vscode.DocumentFormattingEditProvider {
    provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[] | null> {
        return Promise.resolve(zigFormat(document));
    }
}

// Same as full document formatter for now
export class ZigRangeFormatProvider implements vscode.DocumentRangeFormattingEditProvider {
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
