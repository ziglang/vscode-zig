import vscode from "vscode";

import {
    CancellationToken,
    ConfigurationParams,
    LSPAny,
    LanguageClient,
    LanguageClientOptions,
    RequestHandler,
    ResponseError,
    ServerOptions,
} from "vscode-languageclient/node";
import camelCase from "camelcase";
import semver from "semver";

import * as minisign from "./minisign";
import * as versionManager from "./versionManager";
import {
    getHostZigName,
    getZigArchName,
    getZigOSName,
    handleConfigOption,
    resolveExePathAndVersion,
    workspaceConfigUpdateNoThrow,
} from "./zigUtil";
import { zigProvider } from "./zigSetup";

const ZIG_MODE = [
    { language: "zig", scheme: "file" },
    { language: "zig", scheme: "untitled" },
];

let versionManagerConfig: versionManager.Config;
let statusItem: vscode.LanguageStatusItem;
let outputChannel: vscode.LogOutputChannel;
export let client: LanguageClient | null = null;

export async function restartClient(context: vscode.ExtensionContext): Promise<void> {
    const result = await getZLSPath(context);

    if (!result) {
        await stopClient();
        updateStatusItem(null);
        return;
    }

    try {
        const newClient = await startClient(result.exe, result.version);
        void stopClient();
        client = newClient;
        updateStatusItem(result.version);
    } catch (reason) {
        if (reason instanceof Error) {
            void vscode.window.showWarningMessage(`Failed to run ZLS language server: ${reason.message}`);
        } else {
            void vscode.window.showWarningMessage("Failed to run ZLS language server");
        }
        updateStatusItem(null);
    }
}

async function startClient(zlsPath: string, zlsVersion: semver.SemVer): Promise<LanguageClient> {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const debugLog = configuration.get<boolean>("debugLog", false);

    const args: string[] = [];

    if (debugLog) {
        /** `--enable-debug-log` has been deprecated in favor of `--log-level`. https://github.com/zigtools/zls/pull/1957 */
        const zlsCLIRevampVersion = new semver.SemVer("0.14.0-50+3354fdc");
        if (semver.lt(zlsVersion, zlsCLIRevampVersion)) {
            args.push("--enable-debug-log");
        } else {
            args.push("--log-level", "debug");
        }
    }

    const serverOptions: ServerOptions = {
        command: zlsPath,
        args: args,
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: ZIG_MODE,
        outputChannel,
        middleware: {
            workspace: {
                configuration: configurationMiddleware,
            },
        },
    };

    const languageClient = new LanguageClient("zig.zls", "ZLS language server", serverOptions, clientOptions);
    await languageClient.start();
    // Formatting is handled by `zigFormat.ts`
    languageClient.getFeature("textDocument/formatting").clear();
    return languageClient;
}

async function stopClient(): Promise<void> {
    if (!client) return;
    const oldClient = client;
    client = null;
    // The `stop` call will send the "shutdown" notification to the LSP
    await oldClient.stop();
    // The `dipose` call will send the "exit" request to the LSP which actually tells the child process to exit
    await oldClient.dispose();
}

/** returns the file system path to the zls executable */
async function getZLSPath(context: vscode.ExtensionContext): Promise<{ exe: string; version: semver.SemVer } | null> {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    let zlsExePath = configuration.get<string>("path");
    let zlsVersion: semver.SemVer | null = null;

    if (!!zlsExePath) {
        // This will fail on older ZLS version that do not support `zls --version`.
        // It should be more likely that the given executable is invalid than someone using ZLS 0.9.0 or older.
        const result = resolveExePathAndVersion(zlsExePath, "--version");
        if ("message" in result) {
            vscode.window
                .showErrorMessage(`Unexpected 'zig.zls.path': ${result.message}`, "install ZLS", "open settings")
                .then(async (response) => {
                    switch (response) {
                        case "install ZLS":
                            const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
                            await workspaceConfigUpdateNoThrow(zlsConfig, "enabled", "on", true);
                            await workspaceConfigUpdateNoThrow(zlsConfig, "path", undefined);
                            break;
                        case "open settings":
                            await vscode.commands.executeCommand("workbench.action.openSettings", "zig.zls.path");
                            break;
                        case undefined:
                            break;
                    }
                });
            return null;
        }
        return result;
    }

    if (configuration.get<"ask" | "off" | "on">("enabled", "ask") !== "on") return null;

    const zigVersion = zigProvider.getZigVersion();
    if (!zigVersion) return null;

    const result = await fetchVersion(context, zigVersion, true);
    if (!result) return null;

    try {
        zlsExePath = await versionManager.install(versionManagerConfig, result.version);
        zlsVersion = result.version;
    } catch (err) {
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Failed to install ZLS ${result.version.toString()}: ${err.message}`);
        } else {
            void vscode.window.showErrorMessage(`Failed to install ZLS ${result.version.toString()}!`);
        }
        return null;
    }

    return {
        exe: zlsExePath,
        version: zlsVersion,
    };
}

async function configurationMiddleware(
    params: ConfigurationParams,
    token: CancellationToken,
    next: RequestHandler<ConfigurationParams, LSPAny[], void>,
): Promise<LSPAny[] | ResponseError> {
    const optionIndices: Record<string, number | undefined> = {};

    params.items.forEach((param, index) => {
        if (param.section) {
            if (param.section === "zls.zig_exe_path") {
                param.section = "zig.path";
            } else {
                param.section = `zig.zls.${camelCase(param.section.slice(4))}`;
            }
            optionIndices[param.section] = index;
        }
    });

    const result = await next(params, token);
    if (result instanceof ResponseError) {
        return result;
    }

    const configuration = vscode.workspace.getConfiguration("zig.zls");

    for (const name in optionIndices) {
        const index = optionIndices[name] as unknown as number;
        const section = name.slice("zig.zls.".length);
        const configValue = configuration.get(section);
        if (typeof configValue === "string") {
            // Make sure that `""` gets converted to `null` and resolve predefined values
            result[index] = configValue ? handleConfigOption(configValue) : null;
        }

        const inspect = configuration.inspect(section);
        const isDefaultValue =
            configValue === inspect?.defaultValue &&
            inspect?.globalValue === undefined &&
            inspect?.workspaceValue === undefined &&
            inspect?.workspaceFolderValue === undefined;
        if (isDefaultValue) {
            if (name === "zig.zls.semanticTokens") {
                // The extension has a different default value for this config
                // option compared to ZLS
                continue;
            }
            result[index] = null;
        }
    }

    const indexOfZigPath = optionIndices["zig.path"];
    if (indexOfZigPath !== undefined) {
        result[indexOfZigPath] = zigProvider.getZigPath();
    }

    const additionalOptions = configuration.get<Record<string, unknown>>("additionalOptions", {});

    for (const optionName in additionalOptions) {
        const section = optionName.slice("zig.zls.".length);

        const doesOptionExist = configuration.inspect(section)?.defaultValue !== undefined;
        if (doesOptionExist) {
            // The extension has defined a config option with the given name but the user still used `additionalOptions`.
            const response = await vscode.window.showWarningMessage(
                `The config option 'zig.zls.additionalOptions' contains the already existing option '${optionName}'`,
                `Use ${optionName} instead`,
                "Show zig.zls.additionalOptions",
            );
            switch (response) {
                case `Use ${optionName} instead`:
                    const { [optionName]: newValue, ...updatedAdditionalOptions } = additionalOptions;
                    await workspaceConfigUpdateNoThrow(
                        configuration,
                        "additionalOptions",
                        updatedAdditionalOptions,
                        true,
                    );
                    await workspaceConfigUpdateNoThrow(configuration, section, newValue, true);
                    break;
                case "Show zig.zls.additionalOptions":
                    await vscode.commands.executeCommand("workbench.action.openSettingsJson", {
                        revealSetting: { key: "zig.zls.additionalOptions" },
                    });
                    continue;
                case undefined:
                    continue;
            }
        }

        const optionIndex = optionIndices[optionName];
        if (!optionIndex) {
            // ZLS has not requested a config option with the given name.
            continue;
        }

        result[optionIndex] = additionalOptions[optionName];
    }

    return result as unknown[];
}

/**
 * Similar to https://builds.zigtools.org/index.json
 */
interface SelectVersionResponse {
    /** The ZLS version */
    version: string;
    /** `YYYY-MM-DD` */
    date: string;
    [artifact: string]: ArtifactEntry | string | undefined;
}

interface SelectVersionFailureResponse {
    /**
     * The `code` **may** be one of `SelectVersionFailureCode`. Be aware that new
     * codes can be added over time.
     */
    code: number;
    /** A simplified explanation of why no ZLS build could be selected */
    message: string;
}

interface ArtifactEntry {
    /** A download URL */
    tarball: string;
    /** A SHA256 hash of the tarball */
    shasum: string;
    /** Size of the tarball in bytes */
    size: string;
}

async function fetchVersion(
    context: vscode.ExtensionContext,
    zigVersion: semver.SemVer,
    useCache: boolean,
): Promise<{ version: semver.SemVer; artifact: ArtifactEntry } | null> {
    // Should the cache be periodically cleared?
    const cacheKey = `zls-select-version-${zigVersion.raw}`;

    let response: SelectVersionResponse | SelectVersionFailureResponse | null = null;
    try {
        const url = new URL("https://releases.zigtools.org/v1/zls/select-version");
        url.searchParams.append("zig_version", zigVersion.raw);
        url.searchParams.append("compatibility", "only-runtime");

        const fetchResponse = await fetch(url);
        response = (await fetchResponse.json()) as SelectVersionResponse | SelectVersionFailureResponse;

        // Cache the response
        if (useCache) {
            await context.globalState.update(cacheKey, response);
        }
    } catch (err) {
        // Try to read the result from cache
        if (useCache) {
            response = context.globalState.get<SelectVersionResponse | SelectVersionFailureResponse>(cacheKey) ?? null;
        }

        if (!response) {
            if (err instanceof Error) {
                void vscode.window.showErrorMessage(`Failed to query ZLS version: ${err.message}`);
            } else {
                throw err;
            }
            return null;
        }
    }

    if ("message" in response) {
        void vscode.window.showErrorMessage(`Unable to fetch ZLS: ${response.message as string}`);
        return null;
    }

    const hostName = getHostZigName();

    if (!(hostName in response)) {
        void vscode.window.showErrorMessage(
            `A prebuilt ZLS ${response.version} binary is not available for your system. You can build it yourself with https://github.com/zigtools/zls#from-source`,
        );
        return null;
    }

    return {
        version: new semver.SemVer(response.version),
        artifact: response[hostName] as ArtifactEntry,
    };
}

async function isEnabled(): Promise<boolean> {
    const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
    if (!!zlsConfig.get<string>("path")) return true;

    switch (zlsConfig.get<"ask" | "off" | "on">("enabled", "ask")) {
        case "on":
            return true;
        case "off":
            return false;
        case "ask": {
            const response = await vscode.window.showInformationMessage(
                "We recommend enabling the ZLS language server for a better editing experience. Would you like to install it?",
                { modal: true },
                "Yes",
                "No",
            );
            switch (response) {
                case "Yes":
                    await workspaceConfigUpdateNoThrow(zlsConfig, "enabled", "on", true);
                    return true;
                case "No":
                    await workspaceConfigUpdateNoThrow(zlsConfig, "enabled", "off", true);
                    return false;
                case undefined:
                    return false;
            }
        }
    }
}

function updateStatusItem(version: semver.SemVer | null) {
    if (version) {
        statusItem.text = `ZLS ${version.toString()}`;
        statusItem.detail = "ZLS Version";
        statusItem.severity = vscode.LanguageStatusSeverity.Information;
        statusItem.command = {
            title: "View Output",
            command: "zig.zls.openOutput",
        };
    } else {
        statusItem.text = "ZLS not enabled";
        statusItem.detail = undefined;
        statusItem.severity = vscode.LanguageStatusSeverity.Error;
        const zigPath = zigProvider.getZigPath();
        const zigVersion = zigProvider.getZigVersion();
        if (zigPath !== null && zigVersion !== null) {
            statusItem.command = {
                title: "Enable",
                command: "zig.zls.enable",
            };
        } else {
            statusItem.command = undefined;
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    {
        // This check can be removed once enough time has passed so that most users switched to the new value

        // remove the `zls_install` directory from the global storage
        try {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(context.globalStorageUri, "zls_install"), {
                recursive: true,
                useTrash: false,
            });
        } catch {}

        // convert a `zig.zls.path` that points to the global storage to `zig.zls.enabled == "on"`
        const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
        const zlsPath = zlsConfig.get<string>("path", "");
        if (zlsPath.startsWith(context.globalStorageUri.fsPath)) {
            await workspaceConfigUpdateNoThrow(zlsConfig, "enabled", "on", true);
            await workspaceConfigUpdateNoThrow(zlsConfig, "path", undefined, true);
        }
    }

    versionManagerConfig = {
        context: context,
        title: "ZLS",
        exeName: "zls",
        extraTarArgs: [],
        /** https://github.com/zigtools/release-worker */
        minisignKey: minisign.parseKey("RWR+9B91GBZ0zOjh6Lr17+zKf5BoSuFvrx2xSeDE57uIYvnKBGmMjOex"),
        versionArg: "--version",
        mirrorUrls: [],
        canonicalUrl: {
            release: vscode.Uri.parse("https://builds.zigtools.org"),
            nightly: vscode.Uri.parse("https://builds.zigtools.org"),
        },
        getArtifactName(version) {
            const fileExtension = process.platform === "win32" ? "zip" : "tar.xz";
            return `zls-${getZigOSName()}-${getZigArchName()}-${version.raw}.${fileExtension}`;
        },
    };

    // Remove after some time has passed from the prefix change.
    await versionManager.convertOldInstallPrefixes(versionManagerConfig);

    outputChannel = vscode.window.createOutputChannel("ZLS language server", { log: true });
    statusItem = vscode.languages.createLanguageStatusItem("zig.zls.status", ZIG_MODE);
    statusItem.name = "ZLS";
    updateStatusItem(null);

    context.subscriptions.push(
        outputChannel,
        statusItem,
        vscode.commands.registerCommand("zig.zls.enable", async () => {
            const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
            await workspaceConfigUpdateNoThrow(zlsConfig, "enabled", "on", true);
        }),
        vscode.commands.registerCommand("zig.zls.stop", async () => {
            await stopClient();
        }),
        vscode.commands.registerCommand("zig.zls.startRestart", async () => {
            const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
            await workspaceConfigUpdateNoThrow(zlsConfig, "enabled", "on", true);
            await restartClient(context);
        }),
        vscode.commands.registerCommand("zig.zls.openOutput", () => {
            outputChannel.show();
        }),
    );

    if (await isEnabled()) {
        await restartClient(context);
    }

    // These checks are added later to avoid ZLS be started twice because `isEnabled` sets `zig.zls.enabled`.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (change) => {
            // The `zig.path` config option is handled by `zigProvider.onChange`.
            if (
                change.affectsConfiguration("zig.zls.enabled", undefined) ||
                change.affectsConfiguration("zig.zls.path", undefined) ||
                change.affectsConfiguration("zig.zls.debugLog", undefined)
            ) {
                await restartClient(context);
            }
        }),
        zigProvider.onChange.event(async () => {
            await restartClient(context);
        }),
    );
}

export async function deactivate(): Promise<void> {
    await stopClient();
}
