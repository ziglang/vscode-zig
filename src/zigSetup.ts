import vscode from "vscode";

import path from "path";

import axios from "axios";
import semver from "semver";

import * as minisign from "./minisign";
import * as versionManager from "./versionManager";
import { VersionIndex, ZigVersion, getHostZigName, resolveExePathAndVersion } from "./zigUtil";
import { ZigProvider } from "./zigProvider";

let statusItem: vscode.StatusBarItem;
let languageStatusItem: vscode.LanguageStatusItem;
let versionManagerConfig: versionManager.Config;
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

    if (wantedZig.source === WantedZigVersionSource.workspaceBuildZigZon) {
        wantedZig.version = await findClosestSatisfyingZigVersion(context, wantedZig.version);
    }

    try {
        const exePath = await versionManager.install(versionManagerConfig, wantedZig.version);
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
    }
}

async function findClosestSatisfyingZigVersion(
    context: vscode.ExtensionContext,
    version: semver.SemVer,
): Promise<semver.SemVer> {
    if (version.prerelease.length !== 0) return version;
    const cacheKey = `zig-satisfying-version-${version.raw}`;

    try {
        // We can't just return `version` because `0.12.0` should return `0.12.1`.
        const availableVersions = (await getVersions()).map((item) => item.version);
        const selectedVersion = semver.maxSatisfying(availableVersions, `^${version.toString()}`);
        await context.globalState.update(cacheKey, selectedVersion ?? undefined);
        return selectedVersion ?? version;
    } catch {
        const selectedVersion = context.globalState.get<string | null>(cacheKey, null);
        return selectedVersion ? new semver.SemVer(selectedVersion) : version;
    }
}

/**
 * Returns a sorted list of all versions that are provided by Zig's [index.json](https://ziglang.org/download/index.json) and Mach's [index.json](https://pkg.machengine.org/zig/index.json).
 * [Nominated Zig versions](https://machengine.org/docs/nominated-zig/#nominated-zig-history) are sorted to the bottom.
 *
 * Throws an exception when no network connection is available.
 */
async function getVersions(): Promise<ZigVersion[]> {
    const [zigIndexJson, machIndexJson] = await Promise.all([
        axios.get<VersionIndex>("https://ziglang.org/download/index.json", {}),
        axios.get<VersionIndex>("https://pkg.machengine.org/zig/index.json", {}),
    ]);
    const indexJson = { ...machIndexJson.data, ...zigIndexJson.data };

    const hostName = getHostZigName();
    const result: ZigVersion[] = [];
    for (const [key, value] of Object.entries(indexJson)) {
        const name = key === "master" ? "nightly" : key;
        const version = new semver.SemVer(value.version ?? key);
        const release = value[hostName];
        if (release) {
            result.push({
                name: name,
                version: version,
                url: release.tarball,
                sha: release.shasum,
                notes: value.notes,
                isMach: name.includes("mach"),
            });
        }
    }
    if (result.length === 0) {
        throw Error(
            `no pre-built Zig is available for your system '${hostName}', you can build it yourself using https://github.com/ziglang/zig-bootstrap`,
        );
    }
    sortVersions(result);
    return result;
}

function sortVersions(versions: { name?: string; version: semver.SemVer; isMach: boolean }[]) {
    versions.sort((lhs, rhs) => {
        // Mach versions except `mach-latest` move to the end
        if (lhs.name !== "mach-latest" && rhs.name !== "mach-latest" && lhs.isMach !== rhs.isMach)
            return +lhs.isMach - +rhs.isMach;
        return semver.compare(rhs.version, lhs.version);
    });
}

async function selectVersionAndInstall(context: vscode.ExtensionContext) {
    const offlineVersions = await versionManager.query(versionManagerConfig);

    const versions: {
        name?: string;
        version: semver.SemVer;
        /** Whether the version already installed in global extension storage */
        offline: boolean;
        /** Whether is available in `index.json` */
        online: boolean;
        /** Whether the version one of [Mach's nominated Zig versions](https://machengine.org/docs/nominated-zig/#nominated-zig-history)  */
        isMach: boolean;
    }[] = offlineVersions.map((version) => ({
        version: version,
        offline: true,
        online: false,
        isMach: false /* We can't tell if a version is Mach while being offline */,
    }));

    try {
        const onlineVersions = await getVersions();
        outer: for (const onlineVersion of onlineVersions) {
            for (const version of versions) {
                if (semver.eq(version.version, onlineVersion.version)) {
                    version.name ??= onlineVersion.name;
                    version.online = true;
                    version.isMach = onlineVersion.isMach;
                }
            }

            for (const version of versions) {
                if (semver.eq(version.version, onlineVersion.version) && version.name === onlineVersion.name) {
                    continue outer;
                }
            }

            versions.push({
                name: onlineVersion.name,
                version: onlineVersion.version,
                online: true,
                offline: !!offlineVersions.find((item) => semver.eq(item.version, onlineVersion.version)),
                isMach: onlineVersion.isMach,
            });
        }
    } catch (err) {
        if (!offlineVersions.length) {
            if (err instanceof Error) {
                void vscode.window.showErrorMessage(`Failed to query available Zig version: ${err.message}`);
            } else {
                void vscode.window.showErrorMessage(`Failed to query available Zig version!`);
            }
            return;
        } else {
            // Only show the locally installed versions
        }
    }

    sortVersions(versions);
    const placeholderVersion = versions.find((item) => item.version.prerelease.length === 0)?.version;

    const items: vscode.QuickPickItem[] = [];

    const workspaceZig = await getWantedZigVersion(context, [
        WantedZigVersionSource.workspaceZigVersionFile,
        WantedZigVersionSource.workspaceBuildZigZon,
        WantedZigVersionSource.zigVersionConfigOption,
    ]);
    if (workspaceZig !== null) {
        const alreadyInstalled = offlineVersions.some((item) => semver.eq(item.version, workspaceZig.version));
        items.push({
            label: "Use Workspace Version",
            description: alreadyInstalled ? "already installed" : undefined,
            detail: workspaceZig.version.raw,
        });
    }

    const zigInPath = resolveExePathAndVersion(null, "zig", null, "version");
    if (!("message" in zigInPath)) {
        items.push({
            label: "Use Zig in PATH",
            description: zigInPath.exe,
            detail: zigInPath.version.raw,
        });
    }

    items.push(
        {
            label: "Manually Specify Path",
        },
        {
            label: "",
            kind: vscode.QuickPickItemKind.Separator,
        },
    );

    let seenMachVersion = false;
    for (const item of versions) {
        const useName = item.isMach || item.version.prerelease.length !== 0;
        if (item.isMach && !seenMachVersion && item.name !== "mach-latest") {
            seenMachVersion = true;
            items.push({
                label: "Mach's Nominated Zig versions",
                kind: vscode.QuickPickItemKind.Separator,
            });
        }
        items.push({
            label: (useName ? item.name : null) ?? item.version.raw,
            description: item.offline ? "already installed" : undefined,
            detail: useName ? (item.name ? item.version.raw : undefined) : undefined,
        });
    }

    const selection = await vscode.window.showQuickPick(items, {
        title: "Select Zig version to install",
        canPickMany: false,
        placeHolder: placeholderVersion?.raw,
    });
    if (selection === undefined) return;

    switch (selection.label) {
        case "Use Workspace Version":
            await context.workspaceState.update("zig-version", undefined);
            await installZig(context);
            break;
        case "Use Zig in PATH":
            await vscode.workspace.getConfiguration("zig").update("path", "zig", true);
            break;
        case "Manually Specify Path":
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: "Select Zig executable",
            });
            if (!uris) return;
            await vscode.workspace.getConfiguration("zig").update("path", uris[0].path, true);
            break;
        default:
            const version = new semver.SemVer(selection.detail ?? selection.label);
            await context.workspaceState.update("zig-version", version.raw);
            await installZig(context);
            break;
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
    item.name = "Zig Version";
    item.text = version?.toString() ?? "not installed";
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

        // remove the `zig_install` directory from the global storage
        try {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(context.globalStorageUri, "zig_install"), {
                recursive: true,
                useTrash: false,
            });
        } catch {}

        // remove a `zig.path` that points to the global storage.
        const zigConfig = vscode.workspace.getConfiguration("zig");
        const zigPath = zigConfig.get<string>("path", "");
        if (zigPath.startsWith(context.globalStorageUri.fsPath)) {
            await zigConfig.update("path", undefined, true);
        }

        await zigConfig.update("initialSetupDone", undefined, true);
    }

    versionManagerConfig = {
        context: context,
        title: "Zig",
        exeName: "zig",
        extraTarArgs: ["--strip-components=1"],
        /** https://ziglang.org/download */
        minisignKey: minisign.parseKey("RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U"),
        versionArg: "version",
        // taken from https://github.com/mlugg/setup-zig/blob/main/mirrors.json
        mirrorUrls: [
            vscode.Uri.parse("https://pkg.machengine.org/zig"),
            vscode.Uri.parse("https://zigmirror.hryx.net/zig"),
            vscode.Uri.parse("https://zig.linus.dev/zig"),
            vscode.Uri.parse("https://fs.liujiacai.net/zigbuilds"),
            vscode.Uri.parse("https://zigmirror.nesovic.dev/zig"),
        ],
        canonicalUrl: {
            release: vscode.Uri.parse("https://ziglang.org/download"),
            nightly: vscode.Uri.parse("https://ziglang.org/builds"),
        },
    };

    zigProvider = new ZigProvider();

    /** There two status items because there doesn't seem to be a way to pin a language status item by default. */
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1);
    languageStatusItem = vscode.languages.createLanguageStatusItem("zig.status", { language: "zig" });

    context.environmentVariableCollection.description = "Add Zig to PATH";

    const watcher1 = vscode.workspace.createFileSystemWatcher("**/.zigversion");
    const watcher2 = vscode.workspace.createFileSystemWatcher("**/build.zig.zon");

    const refreshZigInstallation = async () => {
        if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
            await installZig(context);
        } else {
            updateStatusItem(statusItem, zigProvider.getZigVersion());
            updateLanguageStatusItem(languageStatusItem, zigProvider.getZigVersion());
        }
    };

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
                await refreshZigInstallation();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        zigProvider.onChange.event((result) => {
            const { exe, version } = result ?? { exe: null, version: null };

            updateStatusItem(statusItem, version);
            updateLanguageStatusItem(languageStatusItem, version);

            updateZigEnvironmentVariableCollection(context, exe);
        }),
        watcher1.onDidCreate(refreshZigInstallation),
        watcher1.onDidChange(refreshZigInstallation),
        watcher1.onDidDelete(refreshZigInstallation),
        watcher1,
        watcher2.onDidCreate(refreshZigInstallation),
        watcher2.onDidChange(refreshZigInstallation),
        watcher2.onDidDelete(refreshZigInstallation),
        watcher2,
    );

    await refreshZigInstallation();
}

export async function deactivate() {
    await versionManager.removeUnusedInstallations(versionManagerConfig);
}
