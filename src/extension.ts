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
        );

        void activateZls(context);
    });
}

export async function deactivate() {
    await deactivateZls();
}
