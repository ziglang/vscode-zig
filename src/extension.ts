import * as vscode from 'vscode';
import ZigCompilerProvider from './zig-compiler-provider.js';
import {zigBuild} from './zig-build.js';
import {ZigFormatProvider, ZigRangeFormatProvider} from './zig-format.js';

// eslint-disable-next-line @typescript-eslint/naming-convention
const ZIG_MODE: vscode.DocumentFilter = {language: 'zig', scheme: 'file'};

// eslint-disable-next-line import/no-mutable-exports
export let buildDiagnosticCollection: vscode.DiagnosticCollection;
export const logChannel = vscode.window.createOutputChannel('zig');
export const zigFormatStatusBar = vscode.window.createStatusBarItem(
	vscode.StatusBarAlignment.Left,
);

export function activate(context: vscode.ExtensionContext) {
	const compiler = new ZigCompilerProvider();
	compiler.activate(context.subscriptions);
	vscode.languages.registerCodeActionsProvider('zig', compiler);

	context.subscriptions.push(
		logChannel,
		vscode.languages.registerDocumentFormattingEditProvider(
			ZIG_MODE,
			new ZigFormatProvider(logChannel),
		),
		vscode.languages.registerDocumentRangeFormattingEditProvider(
			ZIG_MODE,
			new ZigRangeFormatProvider(logChannel),
		),
	);

	buildDiagnosticCollection =
		vscode.languages.createDiagnosticCollection('zig');
	context.subscriptions.push(
		buildDiagnosticCollection,
		vscode.commands.registerCommand('zig.build.workspace', () => {
			zigBuild();
		}),
		vscode.commands.registerCommand('zig.format.file', () => {
			console.log('test');
		}),
	);
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate() {}
