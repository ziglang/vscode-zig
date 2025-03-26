import vscode from "vscode";

import childProcess from "child_process";
import util from "util";

import { DocumentFormattingRequest, TextDocumentIdentifier } from "vscode-languageclient";

import * as zls from "./zls";
import { zigProvider } from "./zigSetup";

const execFile = util.promisify(childProcess.execFile);
const ZIG_MODE: vscode.DocumentSelector = { language: "zig" };

export function registerDocumentFormatting(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    let registeredFormatter: vscode.Disposable | null = null;

    preCompileZigFmt();
    zigProvider.onChange.event(() => {
        preCompileZigFmt();
    }, disposables);

    const onformattingProviderChange = (change: vscode.ConfigurationChangeEvent | null) => {
        if (!change || change.affectsConfiguration("zig.formattingProvider", undefined)) {
            preCompileZigFmt();

            if (vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") === "off") {
                // Unregister the formatting provider
                if (registeredFormatter !== null) registeredFormatter.dispose();
                registeredFormatter = null;
            } else {
                // register the formatting provider
                registeredFormatter ??= vscode.languages.registerDocumentRangeFormattingEditProvider(ZIG_MODE, {
                    provideDocumentRangeFormattingEdits,
                });
            }
        }
    };

    onformattingProviderChange(null);
    vscode.workspace.onDidChangeConfiguration(onformattingProviderChange, disposables);

    return {
        dispose: () => {
            for (const disposable of disposables) {
                disposable.dispose();
            }
            if (registeredFormatter !== null) registeredFormatter.dispose();
        },
    };
}

/** Ensures that `zig fmt` has been JIT compiled. */
function preCompileZigFmt() {
    // This pre-compiles even if "zig.formattingProvider" is "zls".
    if (vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") === "off") return;

    const zigPath = zigProvider.getZigPath();
    if (!zigPath) return;

    try {
        childProcess.execFile(zigPath, ["fmt", "--help"], {
            timeout: 60000, // 60 seconds (this is a very high value because 'zig fmt' is just in time compiled)
        });
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Failed to run 'zig fmt': ${err.message}`);
        } else {
            throw err;
        }
    }
}

async function provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
): Promise<vscode.TextEdit[] | null> {
    if (vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") === "zls") {
        if (zls.client !== null) {
            return await (zls.client.sendRequest(
                DocumentFormattingRequest.type,
                {
                    textDocument: TextDocumentIdentifier.create(document.uri.toString()),
                    options: options,
                },
                token,
            ) as Promise<vscode.TextEdit[] | null>);
        }
    }

    const zigPath = zigProvider.getZigPath();
    if (!zigPath) return null;

    const abortController = new AbortController();
    token.onCancellationRequested(() => {
        abortController.abort();
    });

    const promise = execFile(zigPath, ["fmt", "--stdin"], {
        maxBuffer: 10 * 1024 * 1024, // 10MB
        signal: abortController.signal,
        timeout: 60000, // 60 seconds (this is a very high value because 'zig fmt' is just in time compiled)
    });
    promise.child.stdin?.end(document.getText());

    const { stdout } = await promise;

    if (stdout.length === 0) return null;
    const lastLineId = document.lineCount - 1;
    const wholeDocument = new vscode.Range(0, 0, lastLineId, document.lineAt(lastLineId).text.length);
    return [new vscode.TextEdit(wholeDocument, stdout)];
}
