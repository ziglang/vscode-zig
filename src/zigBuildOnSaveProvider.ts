import vscode from "vscode";

import { handleConfigOption } from "./zigUtil";

export function registerBuildOnSaveProvider(): vscode.Disposable {
    return new BuildOnSaveProvider();
}

type BuildOnSaveProviderKind = "off" | "auto" | "extension" | "zls";

class BuildOnSaveProvider implements vscode.Disposable {
    disposables: vscode.Disposable[] = [];
    /** This may be replacable with `vscode.tasks.taskExecutions` */
    tasks = new Map<string, vscode.TaskExecution | null>();

    constructor() {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            void this.addOrRestart(folder);
        }

        vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
            for (const folder of e.added) {
                await this.addOrRestart(folder);
            }
            for (const folder of e.removed) {
                this.stop(folder);
            }
        }, this.disposables);

        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration("zig.buildOnSaveProvider")) return;

            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                await this.addOrRestart(folder);
            }
        }, this.disposables);
    }

    dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    async addOrRestart(folder: vscode.WorkspaceFolder): Promise<void> {
        this.stop(folder);

        const zigConfig = vscode.workspace.getConfiguration("zig", folder);
        const buildOnSaveProvider = zigConfig.get<BuildOnSaveProviderKind>("buildOnSaveProvider", "auto");
        const buildOnSaveArgs = zigConfig
            .get<string[]>("buildOnSaveArgs", [])
            .map((unresolved) => handleConfigOption(unresolved, folder));

        if (buildOnSaveProvider !== "extension") return;

        if (buildOnSaveArgs.includes("--build-file")) {
            // The build file has been explicitly provided through a command line argument
        } else {
            const workspaceBuildZigUri = vscode.Uri.joinPath(folder.uri, "build.zig");
            try {
                await vscode.workspace.fs.stat(workspaceBuildZigUri);
            } catch {
                return;
            }
        }

        const task = new vscode.Task(
            {
                type: "zig",
            },
            folder,
            "Zig Watch",
            "zig",
            new vscode.ShellExecution("zig", ["build", "--watch", ...buildOnSaveArgs], {}),
            "zig",
        );
        task.isBackground = true;
        task.presentationOptions.reveal = vscode.TaskRevealKind.Never;
        task.presentationOptions.close = true;
        const taskExecutor = await vscode.tasks.executeTask(task);
        this.stop(folder); // Try to stop again just in case a task got started while we were suspended
        this.tasks.set(folder.uri.toString(), taskExecutor);

        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration("zig.buildOnSaveProvider", folder)) {
                // We previously checked that the build on save provider is "extension" so now it has to be something different
                this.stop(folder);
                return;
            }
            if (e.affectsConfiguration("zig.buildOnSaveArgs", folder)) {
                await this.addOrRestart(folder);
            }
        }, this.disposables);
    }

    stop(folder: vscode.WorkspaceFolder): void {
        const oldTask = this.tasks.get(folder.uri.toString());
        if (oldTask) oldTask.terminate();
        this.tasks.delete(folder.uri.toString());
    }
}
