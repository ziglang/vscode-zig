import * as vscode from 'vscode';
import { Range, StatusBarItem, TextEdit } from 'vscode';
import { execCmd } from './zigUtil';

export class ZigFormatProvider implements vscode.DocumentFormattingEditProvider {
    private showError;
    private clearError;

    constructor(statusBarItem: StatusBarItem) {
        statusBarItem.hide();
        this.showError = statusBarMessage(statusBarItem);
        this.clearError = clearStatus(statusBarItem);
    }

    provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        options?: vscode.FormattingOptions,
        token?: vscode.CancellationToken,
    ): Thenable<TextEdit[]> {
        return zigFormat(document)
            .then(({ stdout }) => {
                this.clearError();
                const lastLineId = document.lineCount - 1;
                const wholeDocument = new vscode.Range(
                    0,
                    0,
                    lastLineId,
                    document.lineAt(lastLineId).text.length,
                );
                return [TextEdit.replace(wholeDocument, stdout)];
            })
            .catch(this.showError);
    }
}

// Same as full document formatter for now
export class ZigRangeFormatProvider implements vscode.DocumentRangeFormattingEditProvider {
    private showError;
    private clearError;

    constructor(statusBarItem: StatusBarItem) {
        statusBarItem.hide();
        this.showError = statusBarMessage(statusBarItem);
        this.clearError = clearStatus(statusBarItem);
    }

    provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range,
        options?: vscode.FormattingOptions,
        token?: vscode.CancellationToken,
    ): Thenable<TextEdit[]> {
        return zigFormat(document)
            .then(({ stdout }) => {
                this.clearError();
                const lastLineId = document.lineCount - 1;
                const wholeDocument = new vscode.Range(
                    0,
                    0,
                    lastLineId,
                    document.lineAt(lastLineId).text.length,
                );
                return [TextEdit.replace(wholeDocument, stdout)];
            })
            .catch(this.showError);
    }
}

function zigFormat(document: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('zig');
    const formatCommand = <string[]>config.get('formatCommand');

    const options = {
        cmdArguments: [],
        notFoundText: 'Install the zig stage2 compiler from https://github.com/ziglang/zig',
    };
    const format = execCmd(formatCommand + ' --stdin', options);

    format.stdin.write(document.getText());
    format.stdin.end();

    return format;
}

function clearStatus(statusBarItem: StatusBarItem) {
    return function () {
        statusBarItem.text = 'text';
        statusBarItem.hide();
    }
}

function statusBarMessage(statusBarItem: StatusBarItem) {
    return function (err) {
        const message = 'zig fmt failed. Check the file for syntax errors';

        let editor = vscode.window.activeTextEditor;
        if (editor) {
            statusBarItem.text = message;
            statusBarItem.show();
        }

        return;
    };
}