import path from "path";

import axios from "axios";
import semver from "semver";
import vscode from "vscode";

import * as versionManager from "./versionManager";
import { VersionIndex, ZigVersion, getHostZigName, getVersion, getZigPath } from "./zigUtil";
import { restartClient } from "./zls";

let versionManagerConfig: versionManager.Config;

export async function installZig(context: vscode.ExtensionContext, version: semver.SemVer) {
    const zigPath = await versionManager.install(versionManagerConfig, version);

    const configuration = vscode.workspace.getConfiguration("zig");
    await configuration.update("path", zigPath, true);

    void vscode.window.showInformationMessage(
        `Zig has been installed successfully. Relaunch your integrated terminal to make it available.`,
    );

    void restartClient(context);
}

async function getVersions(): Promise<ZigVersion[]> {
    const indexJson = (await axios.get<VersionIndex>("https://ziglang.org/download/index.json", {})).data;
    const hostName = getHostZigName();
    const result: ZigVersion[] = [];
    for (let key in indexJson) {
        const value = indexJson[key];
        let version: semver.SemVer;
        if (key === "master") {
            key = "nightly";
            version = new semver.SemVer((value as unknown as { version: string }).version);
        } else {
            version = new semver.SemVer(key);
        }
        const release = value[hostName];
        if (release) {
            result.push({
                name: key,
                version: version,
                url: release.tarball,
                sha: release.shasum,
                notes: (value as { notes?: string }).notes,
            });
        }
    }
    if (result.length === 0) {
        throw Error(
            `no pre-built Zig is available for your system '${hostName}', you can build it yourself using https://github.com/ziglang/zig-bootstrap`,
        );
    }
    return result;
}

async function selectVersionAndInstall(context: vscode.ExtensionContext) {
    try {
        const available = await getVersions();

        const items: vscode.QuickPickItem[] = [];
        for (const option of available) {
            items.push({ label: option.name });
        }
        // Recommend latest stable release.
        const placeHolder = available.length > 2 ? available[1].name : undefined;
        const selection = await vscode.window.showQuickPick(items, {
            title: "Select Zig version to install",
            canPickMany: false,
            placeHolder: placeHolder,
        });
        if (selection === undefined) return;
        for (const option of available) {
            if (option.name === selection.label) {
                await installZig(context, option.version);
                return;
            }
        }
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Unable to install Zig: ${err.message}`);
        } else {
            throw err;
        }
    }
}

function updateZigEnvironmentVariableCollection(context: vscode.ExtensionContext) {
    try {
        const zigPath = getZigPath();
        const envValue = path.delimiter + path.dirname(zigPath);
        // Calling `append` means that zig from a user-defined PATH value will take precedence.
        // The added value may have already been added by the user but since we
        // append, it doesn't have any observable.
        context.environmentVariableCollection.append("PATH", envValue);
    } catch {
        context.environmentVariableCollection.delete("PATH");
    }
}

export async function setupZig(context: vscode.ExtensionContext) {
    {
        // convert an empty string for `zig.path` to `zig`.
        // This check can be removed once enough time has passed so that most users switched to the new value

        const zigConfig = vscode.workspace.getConfiguration("zig");
        const initialSetupDone = zigConfig.get<boolean>("initialSetupDone", false);
        const zigPath = zigConfig.get<string>("path");
        if (zigPath === "" && initialSetupDone) {
            await zigConfig.update("path", "zig", true);
        }
    }

    versionManagerConfig = {
        context: context,
        title: "Zig",
        exeName: "zig",
        extraTarArgs: ["--strip-components=1"],
        versionArg: "version",
        canonicalUrl: {
            release: vscode.Uri.parse("https://ziglang.org/download"),
            nightly: vscode.Uri.parse("https://ziglang.org/builds"),
        },
    };

    context.environmentVariableCollection.description = "Add Zig to PATH";
    updateZigEnvironmentVariableCollection(context);

    context.subscriptions.push(
        vscode.commands.registerCommand("zig.install", async () => {
            await selectVersionAndInstall(context);
        }),
        vscode.workspace.onDidChangeConfiguration((change) => {
            if (change.affectsConfiguration("zig.path")) {
                updateZigEnvironmentVariableCollection(context);
            }
        }),
    );

    const configuration = vscode.workspace.getConfiguration("zig");
    if (!configuration.get<boolean>("initialSetupDone")) {
        await configuration.update("initialSetupDone", await initialSetup(context), true);
    }
}

async function initialSetup(context: vscode.ExtensionContext): Promise<boolean> {
    const zigConfig = vscode.workspace.getConfiguration("zig");
    if (!!zigConfig.get<string>("path")) return true;

    const zigResponse = await vscode.window.showInformationMessage(
        "Zig path hasn't been set, do you want to specify the path or install Zig?",
        { modal: true },
        "Install",
        "Specify path",
        "Use Zig in PATH",
    );
    switch (zigResponse) {
        case "Install":
            await selectVersionAndInstall(context);
            const zigPath = vscode.workspace.getConfiguration("zig").get<string>("path");
            if (!zigPath) return false;
            break;
        case "Specify path":
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: "Select Zig executable",
            });
            if (!uris) return false;

            const version = getVersion(uris[0].path, "version");
            if (!version) return false;

            await zigConfig.update("path", uris[0].path, true);
            break;
        case "Use Zig in PATH":
            await zigConfig.update("path", "zig", true);
            break;
        case undefined:
            return false;
    }

    return true;
}
