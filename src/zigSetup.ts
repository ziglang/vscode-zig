import vscode from "vscode";

import path from "path";

import semver from "semver";

import { ZigVersion, getHostZigName, getVersionIndex } from "./zigUtil";
import { VersionManager } from "./versionManager";
import { ZigProvider } from "./zigProvider";

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
        const zlsConfig = vscode.workspace.getConfiguration("zig");
        if (zlsConfig.get<boolean | null>("enabled", null) === null) {
            const zlsPath = zlsConfig.get<string>("path", "");
            if (zlsPath.startsWith(context.globalStorageUri.fsPath)) {
                await zlsConfig.update("path", undefined, true);
            }
        }
    }

    versionManager = new VersionManager(context, "zig");

    zigProvider = new ZigProvider();

    context.environmentVariableCollection.description = "Add Zig to PATH";

    context.subscriptions.push(
        zigProvider,
        vscode.commands.registerCommand("zig.install", async () => {
            await selectVersionAndInstall(context);
        }),
        zigProvider.onChange.event((result) => {
            const { exe } = result ?? { exe: null, version: null };

            updateZigEnvironmentVariableCollection(context, exe);
        }),
    );

    if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
        await installZig(context);
    }
}
