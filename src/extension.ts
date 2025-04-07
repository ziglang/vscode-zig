import vscode from "vscode";

import { activate as activateZls, deactivate as deactivateZls } from "./zls";
import ZigDiagnosticsProvider from "./zigDiagnosticsProvider";
import ZigMainCodeLensProvider from "./zigMainCodeLens";
import ZigTestRunnerProvider from "./zigTestRunnerProvider";
import { registerDocumentFormatting } from "./zigFormat";
import { setupZig } from "./zigSetup";

export async function activate(context: vscode.ExtensionContext) {
    await setupZig(context).finally(() => {
        const compiler = new ZigDiagnosticsProvider();
        compiler.activate(context.subscriptions);

        context.subscriptions.push(registerDocumentFormatting());

        const testRunner = new ZigTestRunnerProvider();
        testRunner.activate(context.subscriptions);

        ZigMainCodeLensProvider.registerCommands(context);
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(
                { language: "zig", scheme: "file" },
                new ZigMainCodeLensProvider(),
            ),
            vscode.commands.registerCommand(
                'zig.toggleMultilineStringLiteral',
                toggleMultilineStringLiteral
            ),
        );
        void activateZls(context);
    });
}

export async function deactivate() {
    await deactivateZls();
}

async function toggleMultilineStringLiteral() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    const { document, selection } = editor;
    if (document.languageId !== 'zig') { return; }

    let newText = '';
    let range = new vscode.Range(selection.start, selection.end);

    const firstLine = document.lineAt(selection.start.line);
    const nonWhitespaceIndex = firstLine.firstNonWhitespaceCharacterIndex;

    for (let lineNum = selection.start.line; lineNum <= selection.end.line; lineNum++) {
        const line = document.lineAt(lineNum);

        const isMLSL = line.text.slice(line.firstNonWhitespaceCharacterIndex).startsWith('\\\\');
        const breakpoint = Math.min(nonWhitespaceIndex, line.firstNonWhitespaceCharacterIndex);

        const newLine = isMLSL
            ? line.text.slice(0, line.firstNonWhitespaceCharacterIndex) + line.text.slice(line.firstNonWhitespaceCharacterIndex).slice(2)
            : line.isEmptyOrWhitespace
                ? ' '.repeat(nonWhitespaceIndex) + '\\\\'
                : line.text.slice(0, breakpoint) + '\\\\' + line.text.slice(breakpoint);
        newText += newLine;
        if (lineNum < selection.end.line) { newText += '\n'; }
        range = range.union(line.range);
    }

    await editor.edit((builder) => { builder.replace(range, newText); });
}