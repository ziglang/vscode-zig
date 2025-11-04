import vscode from "vscode";

import fs from "fs/promises";
import path from "path";

import semver from "semver";

import * as minisign from "./minisign";
import * as versionManager from "./versionManager";
import * as zigUtil from "./zigUtil";
import { ZigProvider } from "./zigProvider";

let statusItem: vscode.StatusBarItem;
let languageStatusItem: vscode.LanguageStatusItem;
let versionManagerConfig: versionManager.Config;
export let zigProvider: ZigProvider;

/** Removes the `zig.path` config option. */
async function installZig(context: vscode.ExtensionContext, temporaryVersion?: semver.SemVer) {
    let version = temporaryVersion;

    if (!version) {
        const wantedZig = await getWantedZigVersion(
            context,
            Object.values(WantedZigVersionSource) as WantedZigVersionSource[],
        );
        version = wantedZig?.version;
        if (wantedZig?.source === WantedZigVersionSource.workspaceBuildZigZon) {
            version = await findClosestSatisfyingZigVersion(context, wantedZig.version);
        }
    }

    if (!version) {
        // Lookup zig in $PATH
        const result = zigUtil.resolveExePathAndVersion("zig", "version");
        if ("exe" in result) {
            await vscode.workspace.getConfiguration("zig").update("path", undefined, true);
            zigProvider.set(result);
            return;
        }
    }

    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (!version) {
        // Default to the latest tagged release
        version = (await getLatestTaggedZigVersion(context)) ?? undefined;
    }

    if (!version) {
        await zigProvider.setAndSave(null);
        return;
    }

    try {
        const exePath = await versionManager.install(versionManagerConfig, version);
        const zigConfig = vscode.workspace.getConfiguration("zig");
        await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "path", undefined, true);
        zigProvider.set({ exe: exePath, version: version });
    } catch (err) {
        zigProvider.set(null);
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Failed to install Zig ${version.toString()}: ${err.message}`);
        } else {
            void vscode.window.showErrorMessage(`Failed to install Zig ${version.toString()}!`);
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
        await context.globalState.update(cacheKey, selectedVersion ? selectedVersion.raw : undefined);
        return selectedVersion ?? version;
    } catch {
        const selectedVersion = context.globalState.get<string | null>(cacheKey, null);
        return selectedVersion ? new semver.SemVer(selectedVersion) : version;
    }
}

async function getLatestTaggedZigVersion(context: vscode.ExtensionContext): Promise<semver.SemVer | null> {
    const cacheKey = "zig-latest-tagged";
    try {
        const zigVersion = await getVersions();
        const latestTagged = zigVersion.find((item) => item.version.prerelease.length === 0);
        const result = latestTagged?.version ?? null;
        await context.globalState.update(cacheKey, latestTagged?.version.raw);
        return result;
    } catch {
        const latestTagged = context.globalState.get<string | null>(cacheKey, null);
        if (latestTagged) {
            return new semver.SemVer(latestTagged);
        }
        return null;
    }
}

/**
 * Returns a sorted list of all versions that are provided by Zig's [index.json](https://ziglang.org/download/index.json) and Mach's [index.json](https://pkg.machengine.org/zig/index.json).
 * [Nominated Zig versions](https://machengine.org/docs/nominated-zig/#nominated-zig-history) are sorted to the bottom.
 *
 * Throws an exception when no network connection is available.
 */
async function getVersions(): Promise<zigUtil.ZigVersion[]> {
    const [zigIndexJson, machIndexJson] = await Promise.all(
        ["https://ziglang.org/download/index.json", "https://pkg.machengine.org/zig/index.json"].map(async (url) => {
            const response = await fetch(url);
            return response.json() as Promise<zigUtil.VersionIndex>;
        }),
    );
    const indexJson = { ...machIndexJson, ...zigIndexJson };

    const result: zigUtil.ZigVersion[] = [];
    for (const [key, value] of Object.entries(indexJson)) {
        const name = key === "master" ? "nightly" : key;
        const version = new semver.SemVer(value.version ?? key);
        const targetName = `${getZigArchName(version)}-${zigUtil.getZigOSName()}`;
        const release = value[targetName];
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
            `no pre-built Zig is available for your system '${zigUtil.getZigArchName("arm")}-${zigUtil.getZigOSName()}}', you can build it yourself using https://github.com/ziglang/zig-bootstrap`,
        );
    }
    sortVersions(result);
    return result;
}

function getZigArchName(zigVersion: semver.SemVer): string {
    switch (zigVersion.compare(new semver.SemVer("0.15.0-dev.836+080ee25ec"))) {
        case -1:
        case 0:
            return zigUtil.getZigArchName("armv7a");
        case 1:
            return zigUtil.getZigArchName("arm");
    }
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

    const zigInPath = zigUtil.resolveExePathAndVersion("zig", "version");
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
            await installZig(context);
            break;
        case "Use Zig in PATH":
            const zigConfig = vscode.workspace.getConfiguration("zig");
            await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "path", "zig", true);
            break;
        case "Manually Specify Path":
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: "Select Zig executable",
            });
            if (!uris) return;
            await zigProvider.setAndSave(uris[0].fsPath);
            break;
        default:
            const version = new semver.SemVer(selection.detail ?? selection.label);
            await showUpdateWorkspaceVersionDialog(version, workspaceZig?.source);
            await installZig(context, version);
            break;
    }
}

async function showUpdateWorkspaceVersionDialog(
    version: semver.SemVer,
    source?: WantedZigVersionSource,
): Promise<void> {
    const workspace = getWorkspaceFolder();

    if (workspace !== null) {
        let buttonName;
        switch (source) {
            case WantedZigVersionSource.workspaceZigVersionFile:
                buttonName = "update .zigversion";
                break;
            case WantedZigVersionSource.workspaceBuildZigZon:
                buttonName = "update build.zig.zon";
                break;
            case WantedZigVersionSource.zigVersionConfigOption:
                buttonName = "update workspace settings";
                break;
            case undefined:
                buttonName = "create .zigversion";
                break;
        }

        const response = await vscode.window.showInformationMessage(
            `Would you like to save Zig ${version.toString()} in this workspace?`,
            buttonName,
        );
        if (!response) return;
    }

    source ??= workspace
        ? WantedZigVersionSource.workspaceZigVersionFile
        : WantedZigVersionSource.zigVersionConfigOption;

    switch (source) {
        case WantedZigVersionSource.workspaceZigVersionFile: {
            if (!workspace) throw new Error("failed to resolve workspace folder");

            const edit = new vscode.WorkspaceEdit();
            edit.createFile(vscode.Uri.joinPath(workspace.uri, ".zigversion"), {
                overwrite: true,
                contents: new Uint8Array(Buffer.from(version.raw)),
            });
            await vscode.workspace.applyEdit(edit);
            break;
        }
        case WantedZigVersionSource.workspaceBuildZigZon: {
            const metadata = await parseBuildZigZon();
            if (!metadata) throw new Error("failed to parse build.zig.zon");

            const edit = new vscode.WorkspaceEdit();
            edit.replace(metadata.document.uri, metadata.minimumZigVersionSourceRange, version.raw);
            await vscode.workspace.applyEdit(edit);
            break;
        }
        case WantedZigVersionSource.zigVersionConfigOption: {
            await vscode.workspace.getConfiguration("zig").update("version", version.raw, !workspace);
            break;
        }
    }
}

interface BuildZigZonMetadata {
    /** The `build.zig.zon` document. */
    document: vscode.TextDocument;
    minimumZigVersion: semver.SemVer;
    /** `.minimum_zig_version = "<start>0.13.0<end>"` */
    minimumZigVersionSourceRange: vscode.Range;
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | null {
    // Supporting multiple workspaces is significantly more complex so we just look for the first workspace.
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0];
    }
    return null;
}

/**
 * Look for a `build.zig.zon` in the current workspace and return the `minimum_zig_version` in it.
 */
async function parseBuildZigZon(): Promise<BuildZigZonMetadata | null> {
    const workspace = getWorkspaceFolder();
    if (!workspace) return null;

    const manifestUri = vscode.Uri.joinPath(workspace.uri, "build.zig.zon");

    let manifest;
    try {
        manifest = await vscode.workspace.openTextDocument(manifestUri);
    } catch {
        return null;
    }
    // Not perfect, but good enough
    const regex = /\n\s*\.minimum_zig_version\s=\s\"(.*)\"/;
    const matches = regex.exec(manifest.getText());
    if (!matches) return null;

    const versionString = matches[1];
    const version = semver.parse(versionString);
    if (!version) return null;

    const startPosition = manifest.positionAt(matches.index + matches[0].length - versionString.length - 1);
    const endPosition = startPosition.translate(0, versionString.length);

    return {
        document: manifest,
        minimumZigVersion: version,
        minimumZigVersionSourceRange: new vscode.Range(startPosition, endPosition),
    };
}

/** The order of these enums defines the default order in which these sources are executed. */
enum WantedZigVersionSource {
    /** `.zigversion` */
    workspaceZigVersionFile = ".zigversion",
    /** The `minimum_zig_version` in `build.zig.zon` */
    workspaceBuildZigZon = "build.zig.zon",
    /** `zig.version` */
    zigVersionConfigOption = "zig.version",
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
                case WantedZigVersionSource.workspaceZigVersionFile:
                    if (workspace) {
                        const zigVersionString = await vscode.workspace.fs.readFile(
                            vscode.Uri.joinPath(workspace.uri, ".zigversion"),
                        );
                        result = semver.parse(zigVersionString.toString().trim());
                    }
                    break;
                case WantedZigVersionSource.workspaceBuildZigZon:
                    const metadata = await parseBuildZigZon();
                    if (metadata?.minimumZigVersion) {
                        result = metadata.minimumZigVersion;
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
        const envValue = path.dirname(zigExePath) + path.delimiter;
        // This will take priority over a user-defined PATH values.
        context.environmentVariableCollection.prepend("PATH", envValue);
    } else {
        context.environmentVariableCollection.delete("PATH");
    }
}

/**
 * Should be called when one of the following events happen:
 * - The Zig executable has been modified
 * - A workspace configuration file has been modified (e.g. `.zigversion`, `build.zig.zon`)
 */
async function updateStatus(context: vscode.ExtensionContext): Promise<void> {
    const zigVersion = zigProvider.getZigVersion();
    const zigPath = zigProvider.getZigPath();

    updateStatusItem(statusItem, zigVersion);
    updateLanguageStatusItem(languageStatusItem, zigVersion);
    updateZigEnvironmentVariableCollection(context, zigPath);

    // Try to check whether the Zig version satifies the `minimum_zig_version` in `build.zig.zon`

    if (!zigVersion || !zigPath) return;
    const buildZigZonMetadata = await parseBuildZigZon();
    if (!buildZigZonMetadata) return;
    if (semver.gte(zigVersion, buildZigZonMetadata.minimumZigVersion)) return;

    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

    void vscode.window
        .showWarningMessage(
            `Your Zig version '${zigVersion.toString()}' does not satisfy the minimum Zig version '${buildZigZonMetadata.minimumZigVersion.toString()}' of your project.`,
            "update Zig",
            "open build.zig.zon",
        )
        .then(async (response) => {
            switch (response) {
                case undefined:
                    break;
                case "update Zig": {
                    // This will source the desired Zig version with `getWantedZigVersion` which may not satisfy the minimum Zig version.
                    // This could happen for example when the a `.zigversion` specifies `0.12.0` but `minimum_zig_version` is `0.13.0`.
                    // The extension would install `0.12.0` and then complain again.
                    await installZig(context);
                    break;
                }
                case "open build.zig.zon": {
                    void vscode.window.showTextDocument(buildZigZonMetadata.document, {
                        selection: buildZigZonMetadata.minimumZigVersionSourceRange,
                    });
                    break;
                }
            }
        });
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
            await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "path", undefined, true);
        }

        await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "initialSetupDone", undefined, true);

        await context.workspaceState.update("zig-version", undefined);

        // Remove incorrect values in the global state that have been added by
        // an older version of the extension.
        for (const key of context.globalState.keys()) {
            if (!key.startsWith("zig-satisfying-version-")) continue;
            const value = context.globalState.get(key);
            if (value !== undefined && typeof value !== "string") {
                await context.globalState.update(key, undefined);
            }
        }

        // convert `zig.buildOnSave` to `zig.buildOnSaveProvider`
        {
            const inspect = zigConfig.inspect("buildOnSave");
            if (inspect?.globalValue !== undefined) {
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSaveProvider", inspect.globalValue, true);
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSave", undefined, true);
            }
            if (inspect?.workspaceValue !== undefined) {
                await zigUtil.workspaceConfigUpdateNoThrow(
                    zigConfig,
                    "buildOnSaveProvider",
                    inspect.workspaceValue,
                    false,
                );
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSave", undefined, false);
            }
        }

        // convert `zig.buildArgs` to `zig.buildOnSaveArgs`
        {
            const inspect = zigConfig.inspect("buildArgs");
            if (inspect?.globalValue) {
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSaveArgs", inspect.globalValue, true);
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildArgs", undefined, true);
            }
            if (inspect?.workspaceValue) {
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSaveArgs", inspect.workspaceValue, false);
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildArgs", undefined, false);
            }
        }
    }

    /// Workaround https://github.com/ziglang/zig/issues/21905
    switch (process.platform) {
        case "darwin":
        case "freebsd":
        case "openbsd":
        case "netbsd":
        case "haiku":
            vscode.workspace.onDidSaveTextDocument(async (document) => {
                if (document.languageId !== "zig") return;
                if (document.uri.scheme !== "file") return;

                const zigVersion = zigProvider.getZigVersion();
                if (!zigVersion) return;

                if (semver.gte(zigVersion, "0.15.0-dev.1372+abf179533")) return;

                const fsPath = document.uri.fsPath;
                try {
                    await fs.copyFile(fsPath, fsPath + ".tmp", fs.constants.COPYFILE_EXCL);
                    await fs.rename(fsPath + ".tmp", fsPath);
                } catch {}
            }, context.subscriptions);
            break;
        case "aix":
        case "android":
        case "linux":
        case "sunos":
        case "win32":
        case "cygwin":
            break;
    }

    let mirrors: vscode.Uri[] = [];
    try {
        const response = await fetch("https://ziglang.org/download/community-mirrors.txt");
        if (response.status !== 200) throw Error("invalid mirrors");
        const mirrorList = await response.text();
        mirrors = mirrorList
            .trim()
            .split("\n")
            .map((u) => vscode.Uri.parse(u));
    } catch {
        // Cannot fetch mirrors, attempt downloading from canonical source.
    }

    versionManagerConfig = {
        context: context,
        title: "Zig",
        exeName: "zig",
        extraTarArgs: ["--strip-components=1"],
        /** https://ziglang.org/download */
        minisignKey: minisign.parseKey("RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U"),
        versionArg: "version",
        mirrorUrls: mirrors,
        canonicalUrl: {
            release: vscode.Uri.parse("https://ziglang.org/download"),
            nightly: vscode.Uri.parse("https://ziglang.org/builds"),
        },
        getArtifactName(version) {
            const fileExtension = process.platform === "win32" ? "zip" : "tar.xz";
            if (
                (version.prerelease.length === 0 && semver.gte(version, "0.14.1")) ||
                semver.gte(version, "0.15.0-dev.631+9a3540d61")
            ) {
                return `zig-${getZigArchName(version)}-${zigUtil.getZigOSName()}-${version.raw}.${fileExtension}`;
            } else {
                return `zig-${zigUtil.getZigOSName()}-${getZigArchName(version)}-${version.raw}.${fileExtension}`;
            }
        },
    };

    // Remove after some time has passed from the prefix change.
    await versionManager.convertOldInstallPrefixes(versionManagerConfig);

    zigProvider = new ZigProvider();

    /** There two status items because there doesn't seem to be a way to pin a language status item by default. */
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1);
    languageStatusItem = vscode.languages.createLanguageStatusItem("zig.status", { language: "zig" });

    context.environmentVariableCollection.description = "Add Zig to PATH";

    const watcher1 = vscode.workspace.createFileSystemWatcher("**/.zigversion");
    const watcher2 = vscode.workspace.createFileSystemWatcher("**/build.zig.zon");

    const refreshZigInstallation = zigUtil.asyncDebounce(async () => {
        if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
            await installZig(context);
        } else {
            await updateStatus(context);
        }
    }, 200);

    if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
        await installZig(context);
    }
    await updateStatus(context);

    const onDidChangeActiveTextEditor = (editor: vscode.TextEditor | undefined) => {
        if (editor?.document.languageId === "zig") {
            statusItem.show();
        } else {
            statusItem.hide();
        }
    };
    onDidChangeActiveTextEditor(vscode.window.activeTextEditor);

    context.subscriptions.push(
        statusItem,
        languageStatusItem,
        vscode.commands.registerCommand("zig.install", async () => {
            await selectVersionAndInstall(context);
        }),
        vscode.workspace.onDidChangeConfiguration((change) => {
            if (change.affectsConfiguration("zig.version")) {
                void refreshZigInstallation();
            }
            if (change.affectsConfiguration("zig.path")) {
                const result = zigProvider.resolveZigPathConfigOption();
                if (result === undefined) return; // error message already reported
                if (result !== null) {
                    zigProvider.set(result);
                }
                void refreshZigInstallation();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        zigProvider.onChange.event(() => {
            void updateStatus(context);
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
}
