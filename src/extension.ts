import * as vscode from "vscode";
import ZigCompilerProvider from "./zigCompilerProvider";
import { ZigFormatProvider, ZigRangeFormatProvider } from "./zigFormat";
import { setupZig } from "./zigSetup";
import { activate as activateZls, deactivate as deactivateZls } from "./zls";

const ZIG_MODE: vscode.DocumentFilter = { language: "zig", scheme: "file" };

export let buildDiagnosticCollection: vscode.DiagnosticCollection;
export const logChannel = vscode.window.createOutputChannel("zig");
export const zigFormatStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

export async function activate(context: vscode.ExtensionContext) {
    await setupZig(context).finally(() => {
        const compiler = new ZigCompilerProvider();
        compiler.activate(context.subscriptions);
        vscode.languages.registerCodeActionsProvider("zig", compiler);

        context.subscriptions.push(logChannel);

        if (vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") === "extension") {
            context.subscriptions.push(
                vscode.languages.registerDocumentFormattingEditProvider(ZIG_MODE, new ZigFormatProvider(logChannel)),
            );
            context.subscriptions.push(
                vscode.languages.registerDocumentRangeFormattingEditProvider(
                    ZIG_MODE,
                    new ZigRangeFormatProvider(logChannel),
                ),
            );
        }

        buildDiagnosticCollection = vscode.languages.createDiagnosticCollection("zig");
        context.subscriptions.push(buildDiagnosticCollection);

        void activateZls(context);
    });
}

export async function deactivate() {
    await deactivateZls();
}
