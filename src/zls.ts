import vscode from "vscode";

import fs from "fs";

import { LanguageClient, LanguageClientOptions, ResponseError, ServerOptions } from "vscode-languageclient/node";
import axios from "axios";
import camelCase from "camelcase";
import mkdirp from "mkdirp";
import semver from "semver";

import { getExePath, getHostZigName, getVersion, getZigPath, isWindows, shouldCheckUpdate } from "./zigUtil";

let outputChannel: vscode.OutputChannel;
export let client: LanguageClient | null = null;

async function startClient() {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const debugLog = configuration.get<boolean>("debugLog", false);

    const zlsPath = getZLSPath();

    const serverOptions: ServerOptions = {
        command: zlsPath,
        args: debugLog ? ["--enable-debug-log"] : [],
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: "zig" }],
        outputChannel,
        middleware: {
            workspace: {
                async configuration(params, token, next) {
                    let indexOfZigPath: number | undefined;

                    params.items.forEach((param, index) => {
                        if (param.section) {
                            if (param.section === "zls.zig_exe_path") {
                                param.section = "zig.path";
                                indexOfZigPath = index;
                            } else {
                                param.section = `zig.zls.${camelCase(param.section.slice(4))}`;
                            }
                        }
                    });

                    const result = await next(params, token);
                    if (result instanceof ResponseError) {
                        return result;
                    }

                    if (indexOfZigPath !== undefined) {
                        try {
                            result[indexOfZigPath] = getZigPath();
                        } catch {
                            // ZLS will try to find Zig by itself and likely fail as well.
                            // This will cause two "Zig can't be found in $PATH" error messages to be reported.
                            result[indexOfZigPath] = null;
                        }
                    }

                    return result as unknown[];
                },
            },
        },
    };

    // Create the language client and start the client.
    client = new LanguageClient("zig.zls", "Zig Language Server", serverOptions, clientOptions);

    return client
        .start()
        .catch((reason: unknown) => {
            if (reason instanceof Error) {
                void vscode.window.showWarningMessage(`Failed to run Zig Language Server (ZLS): ${reason.message}`);
            } else {
                void vscode.window.showWarningMessage("Failed to run Zig Language Server (ZLS)");
            }
            client = null;
        })
        .then(() => {
            if (client && vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") !== "zls") {
                client.getFeature("textDocument/formatting").dispose();
            }
        });
}

export async function stopClient() {
    if (client) await client.stop();
    client = null;
}

// returns the file system path to the zls executable
export function getZLSPath(): string {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string>("path") ?? null;
    return getExePath(zlsPath, "zls", "zig.zls.path");
}

const downloadsRoot = "https://zigtools-releases.nyc3.digitaloceanspaces.com/zls";

interface Version {
    date: string;
    builtWithZigVersion: string;
    zlsVersion: string;
    zlsMinimumBuildVersion: string;
    commit: string;
    targets: string[];
}

interface VersionIndex {
    latest: string;
    latestTagged: string;
    releases: Record<string, string | undefined>;
    versions: Record<string, Version | undefined>;
}

async function getVersionIndex(): Promise<VersionIndex> {
    const index = (await axios.get<VersionIndex>(`${downloadsRoot}/index.json`)).data;
    if (!index.versions[index.latest]) {
        void vscode.window.showErrorMessage("Invalid ZLS version index; please contact a ZLS maintainer.");
        throw new Error("Invalid ZLS version");
    }
    return index;
}

// checks whether there is newer version on master
async function checkUpdate(context: vscode.ExtensionContext) {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string>("path");
    const zlsBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zls_install", "zls").fsPath;
    if (!zlsPath) return;
    if (!zlsPath.startsWith(zlsBinPath)) return;

    // get current version
    const version = getVersion(zlsPath, "--version");
    if (!version) return;

    const index = await getVersionIndex();
    const latestVersionString = version.build.length === 0 ? index.latestTagged : index.latest;
    // having a build number implies nightly version
    const latestVersion = new semver.SemVer(latestVersionString);

    if (semver.gte(version, latestVersion)) return;

    const response = await vscode.window.showInformationMessage("New version of ZLS available", "Install", "Ignore");
    switch (response) {
        case "Install":
            await installVersion(context, latestVersion);
            break;
        case "Ignore":
        case undefined:
            break;
    }
}

export async function install(context: vscode.ExtensionContext, ask: boolean) {
    const path = getZigPath();

    const zlsConfiguration = vscode.workspace.getConfiguration("zig.zls", null);
    const zigVersion = getVersion(path, "version");
    if (!zigVersion) {
        await zlsConfiguration.update("path", undefined, true);
        return;
    }
    // Zig 0.9.0 was the first version to have a tagged zls release
    if (semver.lt(zigVersion, "0.9.0")) {
        if (zlsConfiguration.get("path")) {
            void vscode.window.showErrorMessage(`ZLS is not available for Zig version ${zigVersion.version}`);
        }
        await zlsConfiguration.update("path", undefined, true);
        return;
    }

    if (ask) {
        const result = await vscode.window.showInformationMessage(
            `Do you want to install ZLS (the Zig Language Server) for Zig version ${zigVersion.version}`,
            "Install",
            "Ignore",
        );
        switch (result) {
            case "Install":
                break;
            case "Ignore":
                await zlsConfiguration.update("path", undefined, true);
                return;
            case undefined:
                return;
        }
    }
    let zlsVersion: semver.SemVer;
    if (zigVersion.build.length !== 0) {
        // Nightly, install latest ZLS
        zlsVersion = new semver.SemVer((await getVersionIndex()).latest);
    } else {
        // ZLS does not make releases for patches
        zlsVersion = zigVersion;
        zlsVersion.patch = 0;
    }

    try {
        await installVersion(context, zlsVersion);
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(
                `Unable to install ZLS ${zlsVersion.version} for Zig version ${zigVersion.version}: ${err.message}`,
            );
        } else {
            throw err;
        }
    }
}

async function installVersion(context: vscode.ExtensionContext, version: semver.SemVer) {
    const hostName = getHostZigName();

    await vscode.window.withProgress(
        {
            title: "Installing ZLS",
            location: vscode.ProgressLocation.Notification,
        },
        async (progress) => {
            const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zls_install");
            if (fs.existsSync(installDir.fsPath)) {
                fs.rmSync(installDir.fsPath, { recursive: true, force: true });
            }
            mkdirp.sync(installDir.fsPath);

            const binName = `zls${isWindows ? ".exe" : ""}`;
            const zlsBinPath = vscode.Uri.joinPath(installDir, binName).fsPath;

            progress.report({ message: "downloading executable..." });
            let exe: Buffer;
            try {
                const response = await axios.get<Buffer>(
                    `${downloadsRoot}/${version.raw}/${hostName}/zls${isWindows ? ".exe" : ""}`,
                    {
                        responseType: "arraybuffer",
                        onDownloadProgress: (progressEvent) => {
                            if (progressEvent.total) {
                                const increment = (progressEvent.bytes / progressEvent.total) * 100;
                                progress.report({
                                    message: progressEvent.progress
                                        ? `downloading executable ${(progressEvent.progress * 100).toFixed()}%`
                                        : "downloading executable...",
                                    increment: increment,
                                });
                            }
                        },
                    },
                );
                exe = response.data;
            } catch (err) {
                // Missing prebuilt binary is reported as AccessDenied
                if (axios.isAxiosError(err) && err.response?.status === 403) {
                    void vscode.window.showErrorMessage(
                        `A prebuilt ZLS ${version.version} binary is not available for your system. You can build it yourself with https://github.com/zigtools/zls#from-source`,
                    );
                    return;
                }
                throw err;
            }
            fs.writeFileSync(zlsBinPath, exe, "binary");
            fs.chmodSync(zlsBinPath, 0o755);

            const config = vscode.workspace.getConfiguration("zig.zls");
            await config.update("path", zlsBinPath, true);
        },
    );
}

function checkInstalled(): boolean {
    const zlsPath = vscode.workspace.getConfiguration("zig.zls").get<string>("path");
    if (!zlsPath) {
        void vscode.window.showErrorMessage("This command cannot be run without setting 'zig.zls.path'.", {
            modal: true,
        });
    }
    return !!zlsPath;
}

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel("Zig Language Server");

    vscode.commands.registerCommand("zig.zls.install", async () => {
        try {
            getZigPath();
        } catch {
            void vscode.window.showErrorMessage("This command cannot be run without a valid zig path.", {
                modal: true,
            });
            return;
        }

        await stopClient();
        await install(context, true);
    });

    vscode.commands.registerCommand("zig.zls.stop", async () => {
        if (!checkInstalled()) return;

        await stopClient();
    });

    vscode.commands.registerCommand("zig.zls.startRestart", async () => {
        if (!checkInstalled()) return;

        await stopClient();
        await startClient();
    });

    vscode.commands.registerCommand("zig.zls.update", async () => {
        if (!checkInstalled()) return;

        await stopClient();
        await checkUpdate(context);
    });

    vscode.workspace.onDidChangeConfiguration(async (change) => {
        if (
            change.affectsConfiguration("zig.zls.path", undefined) ||
            change.affectsConfiguration("zig.zls.debugLog", undefined)
        ) {
            await stopClient();
            const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
            if (!!zlsConfig.get<string>("path")) {
                await startClient();
            }
        }
    }, context.subscriptions);

    const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
    if (!zlsConfig.get<string>("path")) return;
    if (zlsConfig.get<boolean>("checkForUpdate") && (await shouldCheckUpdate(context, "zlsUpdate"))) {
        await checkUpdate(context);
    }
    await startClient();
}

export function deactivate(): Thenable<void> {
    return stopClient();
}
