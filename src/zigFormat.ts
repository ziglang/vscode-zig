import vscode from "vscode";

import childProcess from "child_process";

import { getZigPath } from "./zigUtil";

export class ZigFormatProvider implements vscode.DocumentFormattingEditProvider {
    private _channel: vscode.OutputChannel;

    constructor(logChannel: vscode.OutputChannel) {
        this._channel = logChannel;
    }

    async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[] | null> {
        return Promise.resolve(zigFormat(document, this._channel));
    }
}

// Same as full document formatter for now
export class ZigRangeFormatProvider implements vscode.DocumentRangeFormattingEditProvider {
    private _channel: vscode.OutputChannel;
    constructor(logChannel: vscode.OutputChannel) {
        this._channel = logChannel;
    }

    provideDocumentRangeFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[] | null> {
        return Promise.resolve(zigFormat(document, this._channel));
    }
}

function zigFormat(document: vscode.TextDocument, logChannel: vscode.OutputChannel): vscode.TextEdit[] | null {
    const zigPath = getZigPath();

    const { error, stdout, stderr } = childProcess.spawnSync(zigPath, ["fmt", "--stdin"], {
        input: document.getText(),
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: "utf8",
        timeout: 60000, // 60 seconds (this is a very high value because 'zig fmt' is just in time compiled)
    });

    if (error) {
        const config = vscode.workspace.getConfiguration("zig");
        logChannel.clear();
        if (stderr.length !== 0) {
            logChannel.appendLine(stderr.replace("<stdin>", document.fileName));
            if (config.get<boolean>("revealOutputChannelOnFormattingError")) {
                logChannel.show(true);
            }
        } else {
            void vscode.window.showErrorMessage(error.message);
        }
        return null;
    }

    if (stdout.length === 0) return null;
    const lastLineId = document.lineCount - 1;
    const wholeDocument = new vscode.Range(0, 0, lastLineId, document.lineAt(lastLineId).text.length);
    return [new vscode.TextEdit(wholeDocument, stdout)];
}
