import vscode from "vscode";

import path from "path";

import semver from "semver";

import { ZigVersion, getHostZigName, getVersionIndex } from "./zigUtil";
import { VersionManager } from "./versionManager";
import { ZigProvider } from "./zigProvider";

let statusItem: vscode.StatusBarItem;
let languageStatusItem: vscode.LanguageStatusItem;
let versionManager: VersionManager;
export let zigProvider: ZigProvider;

/** Removes the `zig.path` config option. */
async function installZig(context: vscode.ExtensionContext) {
    const wantedZig = await getWantedZigVersion(
        context,
        Object.values(WantedZigVersionSource) as WantedZigVersionSource[],
    );
    if (!wantedZig) {
        await vscode.workspace.getConfiguration("zig").update("path", undefined, true);
        zigProvider.set(null);
        return;
    }

    try {
        const exePath = await versionManager.install(wantedZig.version);
        await vscode.workspace.getConfiguration("zig").update("path", undefined, true);
        zigProvider.set({ exe: exePath, version: wantedZig.version });
    } catch (err) {
        zigProvider.set(null);
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(
                `Failed to install Zig ${wantedZig.version.toString()}: ${err.message}`,
            );
        } else {
            void vscode.window.showErrorMessage(`Failed to install Zig ${wantedZig.version.toString()}!`);
        }
        return;
    }
}

async function getVersions(): Promise<ZigVersion[]> {
    const hostName = getHostZigName();
    const indexJson = await getVersionIndex();
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
                await context.workspaceState.update("zig-version", option.version.raw);
                await installZig(context);

                void vscode.window.showInformationMessage(
                    `Zig ${option.version.toString()} has been installed successfully. Relaunch your integrated terminal to make it available.`,
                );
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

/** The order of these enums defines the default order in which these sources are executed. */
enum WantedZigVersionSource {
    workspaceState = "workspace-state",
    /** `.zigversion` */
    workspaceZigVersionFile = ".zigversion",
    /** The `minimum_zig_version` in `build.zig.zon` */
    workspaceBuildZigZon = "build.zig.zon",
    /** `zig.version` */
    zigVersionConfigOption = "zig.version",
    latestTagged = "latest-tagged",
}

/** Try to resolve the (workspace-specific) Zig version. */
async function getWantedZigVersion(
    context: vscode.ExtensionContext,
    /** List of "sources" that should are applied in the given order to resolve the wanted Zig version */
    sources: WantedZigVersionSource[],
): Promise<{
    version: semver.SemVer;
    source: WantedZigVersionSource;
} | null> {
    let workspace: vscode.WorkspaceFolder | null = null;
    // Supporting multiple workspaces is significantly more complex so we just look for the first workspace.
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspace = vscode.workspace.workspaceFolders[0];
    }

    for (const source of sources) {
        let result: semver.SemVer | null = null;

        try {
            switch (source) {
                case WantedZigVersionSource.workspaceState:
                    // `context.workspaceState` appears to behave like `context.globalState` when outside of a workspace
                    // There is currently no way to remove the specified zig version.
                    const wantedZigVersion = context.workspaceState.get<string>("zig-version");
                    result = wantedZigVersion ? new semver.SemVer(wantedZigVersion) : null;
                    break;
                case WantedZigVersionSource.workspaceZigVersionFile:
                    if (workspace) {
                        const zigVersionString = await vscode.workspace.fs.readFile(
                            vscode.Uri.joinPath(workspace.uri, ".zigversion"),
                        );
                        result = semver.parse(zigVersionString.toString().trim());
                    }
                    break;
                case WantedZigVersionSource.workspaceBuildZigZon:
                    if (workspace) {
                        const manifest = await vscode.workspace.fs.readFile(
                            vscode.Uri.joinPath(workspace.uri, "build.zig.zon"),
                        );
                        // Not perfect, but good enough
                        const matches = /\n\s*\.minimum_zig_version\s=\s\"(.*)\"/.exec(manifest.toString());
                        if (matches) {
                            result = semver.parse(matches[1]);
                        }
                    }
                    break;
                case WantedZigVersionSource.zigVersionConfigOption:
                    const versionString = vscode.workspace.getConfiguration("zig").get<string>("version");
                    if (versionString) {
                        result = semver.parse(versionString);
                        if (!result) {
                            void vscode.window.showErrorMessage(
                                `Invalid 'zig.version' config option. '${versionString}' is not a valid Zig version`,
                            );
                        }
                    }
                    break;
                case WantedZigVersionSource.latestTagged:
                    const cacheKey = "zig-latest-tagged";
                    try {
                        const zigVersion = await getVersions();
                        const latestTagged = zigVersion.find((item) => item.version.prerelease.length === 0);
                        result = latestTagged?.version ?? null;
                        await context.globalState.update(cacheKey, latestTagged?.version.raw);
                    } catch {
                        const latestTagged = context.globalState.get<string | null>(cacheKey, null);
                        if (latestTagged) {
                            result = new semver.SemVer(latestTagged);
                        }
                    }
                    break;
            }
        } catch {}

        if (!result) continue;

        return {
            version: result,
            source: source,
        };
    }
    return null;
}

function updateStatusItem(item: vscode.StatusBarItem, version: semver.SemVer | null) {
    item.name = "Zig";
    item.text = `Zig ${version?.toString() ?? "not installed"}`;
    item.tooltip = "Select Zig Version";
    item.command = {
        title: "Select Version",
        command: "zig.install",
    };
    if (version) {
        item.backgroundColor = undefined;
    } else {
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
}

function updateLanguageStatusItem(item: vscode.LanguageStatusItem, version: semver.SemVer | null) {
    item.name = "Zig";
    if (version) {
        item.text = `Zig ${version.toString()}`;
        item.detail = "Zig Version";
        item.severity = vscode.LanguageStatusSeverity.Information;
    } else {
        item.text = "Zig not installed";
        item.severity = vscode.LanguageStatusSeverity.Error;
    }
    item.command = {
        title: "Select Version",
        command: "zig.install",
    };
}

function updateZigEnvironmentVariableCollection(context: vscode.ExtensionContext, zigExePath: string | null) {
    if (zigExePath) {
        const envValue = path.delimiter + path.dirname(zigExePath);
        // Calling `append` means that zig from a user-defined PATH value will take precedence.
        // The added value may have already been added by the user but since we
        // append, it doesn't have any observable.
        context.environmentVariableCollection.append("PATH", envValue);
    } else {
        context.environmentVariableCollection.delete("PATH");
    }
}

export async function setupZig(context: vscode.ExtensionContext) {
    {
        // This check can be removed once enough time has passed so that most users switched to the new value

        // remove a `zig.path` that points to the global storage.
        const configuration = vscode.workspace.getConfiguration("zig");
        const zigPath = configuration.get<string>("path", "");
        if (zigPath.startsWith(context.globalStorageUri.fsPath)) {
            await configuration.update("path", undefined, true);
        }
    }

    versionManager = new VersionManager(context, "zig");

    zigProvider = new ZigProvider();

    /** There two status items because there doesn't seem to be a way to pin a language status item by default. */
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1);
    languageStatusItem = vscode.languages.createLanguageStatusItem("zig.status", { language: "zig" });

    context.environmentVariableCollection.description = "Add Zig to PATH";

    const onDidChangeActiveTextEditor = (editor: vscode.TextEditor | undefined) => {
        if (editor?.document.languageId === "zig") {
            statusItem.show();
        } else {
            statusItem.hide();
        }
    };
    onDidChangeActiveTextEditor(vscode.window.activeTextEditor);

    context.subscriptions.push(
        zigProvider,
        statusItem,
        languageStatusItem,
        vscode.commands.registerCommand("zig.install", async () => {
            await selectVersionAndInstall(context);
        }),
        vscode.workspace.onDidChangeConfiguration(async (change) => {
            // The `zig.path` config option is handled by `zigProvider.onChange`.
            if (change.affectsConfiguration("zig.version")) {
                if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
                    await installZig(context);
                }
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        zigProvider.onChange.event((result) => {
            const { exe, version } = result ?? { exe: null, version: null };

            updateStatusItem(statusItem, version);
            updateLanguageStatusItem(languageStatusItem, version);

            updateZigEnvironmentVariableCollection(context, exe);
        }),
    );

    if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
        await installZig(context);
    }
}
