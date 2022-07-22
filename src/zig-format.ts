import vscode, {Range, TextEdit, OutputChannel} from 'vscode';
import {execCmd} from './zig-util.js';

export class ZigFormatProvider
	implements vscode.DocumentFormattingEditProvider
{
	private readonly _channel: OutputChannel;

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
			.then(({stdout}) => {
				logger.clear();
				const lastLineId = document.lineCount - 1;
				const wholeDocument = new Range(
					0,
					0,
					lastLineId,
					document.lineAt(lastLineId).text.length,
				);
				return [new TextEdit(wholeDocument, stdout)];
			})
			.catch((error) => {
				const config = vscode.workspace.getConfiguration('zig');

				logger.clear();
				logger.appendLine(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-call
					error.toString().replace('<stdin>', document.fileName),
				);
				if (config.get<boolean>('revealOutputChannelOnFormattingError')) {
					logger.show(true);
				}

				return null;
			});
	}
}

// Same as full document formatter for now
export class ZigRangeFormatProvider
	implements vscode.DocumentRangeFormattingEditProvider
{
	private readonly _channel: OutputChannel;
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
			.then(({stdout}) => {
				logger.clear();
				const lastLineId = document.lineCount - 1;
				const wholeDocument = new vscode.Range(
					0,
					0,
					lastLineId,
					document.lineAt(lastLineId).text.length,
				);
				return [new TextEdit(wholeDocument, stdout)];
			})
			.catch((error) => {
				const config = vscode.workspace.getConfiguration('zig');

				logger.clear();
				logger.appendLine(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-call
					error.toString().replace('<stdin>', document.fileName),
				);
				if (config.get<boolean>('revealOutputChannelOnFormattingError')) {
					logger.show(true);
				}

				return null;
			});
	}
}

async function zigFormat(document: vscode.TextDocument) {
	const config = vscode.workspace.getConfiguration('zig');
	const zigPath = config.get<string>('zigPath') || 'zig';

	const options = {
		cmdArguments: ['fmt', '--stdin'],
		notFoundText:
			'Could not find zig. Please add zig to your PATH or specify a custom path to the zig binary in your settings.',
	};
	const format = execCmd(zigPath, options);

	// @ts-expect-error: To be fixed
	format.stdin.write(document.getText()); // eslint-disable-line @typescript-eslint/no-unsafe-call
	// @ts-expect-error: To be fixed
	format.stdin.end(); // eslint-disable-line @typescript-eslint/no-unsafe-call

	return format;
}
