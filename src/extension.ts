import vscode from "vscode";

import { activate as activateZls, deactivate as deactivateZls } from "./zls";
import { deactivate as deactivateSetupZig, setupZig } from "./zigSetup";
import ZigDiagnosticsProvider from "./zigDiagnosticsProvider";
import { registerDocumentFormatting } from "./zigFormat";

export async function activate(context: vscode.ExtensionContext) {
    await setupZig(context).finally(() => {
        const compiler = new ZigDiagnosticsProvider();
        compiler.activate(context.subscriptions);

        context.subscriptions.push(registerDocumentFormatting());

        void activateZls(context);
    });
}

export async function deactivate() {
    await deactivateZls();
    await deactivateSetupZig();
}
