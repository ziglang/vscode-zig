'use strict';

import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';

export default class ZigCompilerProvider implements vscode.CodeActionProvider {
    private diagnosticCollection: vscode.DiagnosticCollection;
    
	public activate(subscriptions: vscode.Disposable[]) {
		subscriptions.push(this);
		this.diagnosticCollection = vscode.languages.createDiagnosticCollection();

		vscode.workspace.onDidOpenTextDocument(this.doCompile, this, subscriptions);
		vscode.workspace.onDidCloseTextDocument((textDocument)=> {
			this.diagnosticCollection.delete(textDocument.uri);
		}, null, subscriptions);

		vscode.workspace.onDidSaveTextDocument(this.doCompile, this);

		// Hlint all open haskell documents
		vscode.workspace.textDocuments.forEach(this.doCompile, this);
	}

	public dispose(): void {
		this.diagnosticCollection.clear();
		this.diagnosticCollection.dispose();
	}

    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Command[]> {
        throw new Error("Method not implemented.");
    }
	
	private doCompile(textDocument: vscode.TextDocument) {
		if (textDocument.languageId !== 'zig') {
			return;
		}
		
		let decoded = ''
		let diagnostics: vscode.Diagnostic[] = [];

		let childProcess = cp.spawn('zig', [ 'build-exe', textDocument.fileName ], undefined);
		if (childProcess.pid) {
			childProcess.stderr.on('data', (data: Buffer) => {
				decoded += data;
			});
			childProcess.stdout.on('end', () => {
                let regex = /(.*):(\d*):(\d*):([^:]*):(.*)/g;
                for (let match = regex.exec(decoded); match; 
                     match = regex.exec(decoded)) 
                {
                    let path    = match[1];
                    let line    = parseInt(match[2]) - 1;
                    let column  = parseInt(match[3]) - 1;
                    let type    = match[4];
                    let message = match[5];

					let severity = type.trim().toLowerCase() === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
					let range = new vscode.Range(line, column, 
                                                 line, column + 1);
					let diagnostic = new vscode.Diagnostic(range, message, severity);
					diagnostics.push(diagnostic);
                }
                    
                this.diagnosticCollection.set(textDocument.uri, diagnostics);
			});
		}
	}
}