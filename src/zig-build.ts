import {resolve as pathResolve} from 'node:path';
import cp from 'node:child_process';
import vscode from 'vscode';
import {buildDiagnosticCollection, logChannel} from './extension.js';

export function zigBuild(): void {
	const editor = vscode.window.activeTextEditor;

	const textDocument = editor.document;
	if (textDocument.languageId !== 'zig') {
		return;
	}

	const config = vscode.workspace.getConfiguration('zig');
	const buildOption = config.get<string>('buildOption');
	const processArg: string[] = [buildOption];

	switch (buildOption) {
		case 'build':
			break;
		default:
			processArg.push(textDocument.fileName);
			break;
	}

	const extraArgs = config.get<string[]>('buildArgs');
	for (const element of extraArgs) {
		processArg.push(element);
	}

	const cwd = vscode.workspace.getWorkspaceFolder(editor.document.uri).uri
		.fsPath;
	const buildPath = config.get<string>('zigPath') || 'zig';

	logChannel.appendLine(`Starting building the current workspace at ${cwd}`);

	const childProcess = cp.execFile(
		buildPath,
		processArg,
		{cwd},
		(error, stdout, stderr) => {
			logChannel.appendLine(stderr);
			const diagnostics: Record<string, vscode.Diagnostic[]> = {};
			const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

			buildDiagnosticCollection.clear();
			for (let match = regex.exec(stderr); match; match = regex.exec(stderr)) {
				let path = match[1].trim();
				try {
					if (!path.includes(cwd)) {
						path = pathResolve(cwd, path);
					}
				} catch {}

				const line = Number.parseInt(match[2], 10) - 1;
				const column = Number.parseInt(match[3], 10) - 1;
				const type = match[4];
				const message = match[5];

				const severity =
					type.trim().toLowerCase() === 'error'
						? vscode.DiagnosticSeverity.Error
						: vscode.DiagnosticSeverity.Information;

				const range = new vscode.Range(
					line,
					column,
					line,
					Number.POSITIVE_INFINITY,
				);

				if (!diagnostics[path]) {
					diagnostics[path] = [];
				}

				diagnostics[path].push(new vscode.Diagnostic(range, message, severity));
			}

			for (const path in diagnostics) {
				if (Object.hasOwn(diagnostics, path)) {
					const diagnostic = diagnostics[path];
					buildDiagnosticCollection.set(vscode.Uri.file(path), diagnostic);
				}
			}
		},
	);
}
