import * as vscode from 'vscode';
import { Range, StatusBarItem, TextEdit, OutputChannel } from 'vscode';
import { execCmd } from './zigUtil';

export class ZigFormatProvider implements vscode.DocumentFormattingEditProvider {
    private _channel: OutputChannel;

    constructor(logChannel: OutputChannel) {
        this._channel = logChannel;
    }

    provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        options?: vscode.FormattingOptions,
        token?: vscode.CancellationToken,
    ): Thenable<TextEdit[]> {
        const logger = this._channel;
        return zigFormat(document)
            .then(({ stdout }) => {
                logger.clear();
                const lastLineId = document.lineCount - 1;
                const wholeDocument = new vscode.Range(
                    0,
                    0,
                    lastLineId,
                    document.lineAt(lastLineId).text.length,
                );
                return [TextEdit.replace(wholeDocument, stdout)];
            })
            .catch((reason) => {
                logger.clear();
                logger.appendLine(reason);
                logger.show()
                return null;
            });
    }
}

// Same as full document formatter for now
export class ZigRangeFormatProvider implements vscode.DocumentRangeFormattingEditProvider {
    private _channel: OutputChannel;
    constructor(logChannel: OutputChannel) {
        this._channel = logChannel;
    }

    provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range,
        options?: vscode.FormattingOptions,
        token?: vscode.CancellationToken,
    ): Thenable<TextEdit[]> {
        const logger = this._channel;
        return zigFormat(document)
            .then(({ stdout }) => {
                logger.clear();
                const lastLineId = document.lineCount - 1;
                const wholeDocument = new vscode.Range(
                    0,
                    0,
                    lastLineId,
                    document.lineAt(lastLineId).text.length,
                );
                return [TextEdit.replace(wholeDocument, stdout)];
            })
            .catch((reason) => {
                logger.clear();
                logger.appendLine(reason);
                logger.show()
                return null;
            });
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



