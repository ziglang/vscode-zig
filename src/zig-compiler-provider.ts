import {resolve as pathResolve} from 'node:path';
import cp from 'node:child_process';
import vscode from 'vscode';
import {throttle} from 'lodash-es';

export default class ZigCompilerProvider implements vscode.CodeActionProvider {
	private buildDiagnostics: vscode.DiagnosticCollection;
	private astDiagnostics: vscode.DiagnosticCollection;
	private readonly dirtyChange = new WeakMap<vscode.Uri, boolean>();

	public activate(subscriptions: vscode.Disposable[]) {
		subscriptions.push(this);
		this.buildDiagnostics = vscode.languages.createDiagnosticCollection('zig');
		this.astDiagnostics = vscode.languages.createDiagnosticCollection('zig');

		// Vscode.workspace.onDidOpenTextDocument(this.doCompile, this, subscriptions);
		// vscode.workspace.onDidCloseTextDocument(
		//   (textDocument) => {
		//     this.diagnosticCollection.delete(textDocument.uri);
		//   },
		//   null,
		//   subscriptions
		// );

		// vscode.workspace.onDidSaveTextDocument(this.doCompile, this);
		vscode.workspace.onDidChangeTextDocument(
			this.maybeDoASTGenErrorCheck,
			this,
		);
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	maybeDoASTGenErrorCheck(change: vscode.TextDocumentChangeEvent) {
		if (change.document.languageId !== 'zig') {
			return;
		}

		if (change.document.isClosed) {
			this.astDiagnostics.delete(change.document.uri);
		}

		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		this.doASTGenErrorCheck(change);

		if (!change.document.isUntitled) {
			const config = vscode.workspace.getConfiguration('zig');
			if (
				config.get<boolean>('buildOnSave') &&
				this.dirtyChange.has(change.document.uri) &&
				this.dirtyChange.get(change.document.uri) !== change.document.isDirty &&
				!change.document.isDirty
			) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call
				this.doCompile(change.document);
			}

			this.dirtyChange.set(change.document.uri, change.document.isDirty);
		}
	}

	public dispose(): void {
		this.buildDiagnostics.clear();
		this.astDiagnostics.clear();
		this.buildDiagnostics.dispose();
		this.astDiagnostics.dispose();
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	private _doASTGenErrorCheck(change: vscode.TextDocumentChangeEvent) {
		const config = vscode.workspace.getConfiguration('zig');
		const textDocument = change.document;
		if (textDocument.languageId !== 'zig') {
			return;
		}

		// eslint-disable-next-line @typescript-eslint/naming-convention
		const zig_path = config.get('zigPath') || 'zig';
		const cwd = vscode.workspace.getWorkspaceFolder(textDocument.uri).uri
			.fsPath;

		const childProcess = cp.spawn(zig_path as string, ['ast-check'], {cwd});

		if (!childProcess.pid) {
			return;
		}

		let stderr = '';
		childProcess.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});

		childProcess.stdin.end(change.document.getText(null));

		childProcess.once('close', () => {
			// eslint-disable-next-line  @typescript-eslint/no-unsafe-call
			this.doASTGenErrorCheck.cancel();
			this.astDiagnostics.delete(textDocument.uri);

			if (stderr.length === 0) {
				return;
			}

			const diagnostics: Record<string, vscode.Diagnostic[]> = {};
			const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

			for (let match = regex.exec(stderr); match; match = regex.exec(stderr)) {
				const path = textDocument.uri.fsPath;

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
					this.astDiagnostics.set(textDocument.uri, diagnostic);
				}
			}
		});
	}

	private _doCompile(textDocument: vscode.TextDocument) {
		const config = vscode.workspace.getConfiguration('zig');

		const buildOption = config.get<string>('buildOption');
		const processArg: string[] = [buildOption];
		let workspaceFolder = vscode.workspace.getWorkspaceFolder(textDocument.uri);
		if (!workspaceFolder && vscode.workspace.workspaceFolders.length > 0) {
			workspaceFolder = vscode.workspace.workspaceFolders[0];
		}

		const cwd = workspaceFolder.uri.fsPath;

		switch (buildOption) {
			case 'build': {
				const buildFilePath = config.get<string>('buildFilePath');
				processArg.push('--build-file');
				try {
					processArg.push(
						// eslint-disable-next-line no-template-curly-in-string
						pathResolve(buildFilePath.replace('${workspaceFolder}', cwd)),
					);
				} catch {}

				break;
			}

			default:
				processArg.push(textDocument.fileName);
				break;
		}

		const extraArgs = config.get<string[]>('buildArgs');
		for (const element of extraArgs) {
			processArg.push(element);
		}

		let decoded = '';
		const childProcess = cp.spawn('zig', processArg, {cwd});
		if (childProcess.pid) {
			childProcess.stderr.on('data', (data: string) => {
				decoded += data;
			});
			childProcess.stdout.on('end', () => {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call
				this.doCompile.cancel();
				const diagnostics: Record<string, vscode.Diagnostic[]> = {};
				const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g;

				this.buildDiagnostics.clear();
				for (
					let match = regex.exec(decoded);
					match;
					match = regex.exec(decoded)
				) {
					let path = match[1].trim();
					try {
						if (!path.includes(cwd)) {
							path = pathResolve(workspaceFolder.uri.fsPath, path);
						}
					} catch {}

					const line = Number.parseInt(match[2], 10) - 1;
					const column = Number.parseInt(match[3], 10) - 1;
					const type = match[4];
					const message = match[5];

					// De-dupe build errors with ast errors
					if (this.astDiagnostics.has(textDocument.uri)) {
						for (const diag of this.astDiagnostics.get(textDocument.uri)) {
							if (
								diag.range.start.line === line &&
								diag.range.start.character === column
							) {
								continue;
							}
						}
					}

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

					diagnostics[path].push(
						new vscode.Diagnostic(range, message, severity),
					);
				}

				for (const path in diagnostics) {
					if (Object.hasOwn(diagnostics, path)) {
						const diagnostic = diagnostics[path];
						this.buildDiagnostics.set(vscode.Uri.file(path), diagnostic);
					}
				}
			});
		}
	}

	/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/member-ordering, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
	doASTGenErrorCheck = throttle(this._doASTGenErrorCheck, 16, {
		trailing: true,
	});

	doCompile = throttle(this._doCompile, 60);
	public provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range,
		context: vscode.CodeActionContext,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.Command[]> {
		return [];
	}
	/* eslint-enable */
}
