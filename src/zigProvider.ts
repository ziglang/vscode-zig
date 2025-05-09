import vscode from "vscode";

import semver from "semver";

import { resolveExePathAndVersion, workspaceConfigUpdateNoThrow } from "./zigUtil";

interface ExeWithVersion {
    exe: string;
    version: semver.SemVer;
}

export class ZigProvider {
    onChange: vscode.EventEmitter<ExeWithVersion | null> = new vscode.EventEmitter();
    private value: ExeWithVersion | null;

    constructor() {
        this.value = this.resolveZigPathConfigOption() ?? null;
    }

    /** Returns the version of the Zig executable that is currently being used. */
    public getZigVersion(): semver.SemVer | null {
        return this.value?.version ?? null;
    }

    /** Returns the path to the Zig executable that is currently being used. */
    public getZigPath(): string | null {
        return this.value?.exe ?? null;
    }

    /** Set the path the Zig executable. The `zig.path` config option will be ignored */
    public set(value: ExeWithVersion | null) {
        if (value === null && this.value === null) return;
        if (value !== null && this.value !== null && value.version.compare(this.value.version) === 0) return;
        this.value = value;
        this.onChange.fire(value);
    }

    /**
     * Set the path the Zig executable. Will be saved in `zig.path` config option.
     *
     * @param zigPath The path to the zig executable. If `null`, the `zig.path` config option will be removed.
     */
    public async setAndSave(zigPath: string | null) {
        const zigConfig = vscode.workspace.getConfiguration("zig");
        if (!zigPath) {
            await workspaceConfigUpdateNoThrow(zigConfig, "path", undefined, true);
            return;
        }
        const newValue = this.resolveZigPathConfigOption(zigPath);
        if (!newValue) return;
        await workspaceConfigUpdateNoThrow(zigConfig, "path", newValue.exe, true);
        this.set(newValue);
    }

    /** Resolves the `zig.path` configuration option. */
    public resolveZigPathConfigOption(zigPath?: string): ExeWithVersion | null | undefined {
        zigPath ??= vscode.workspace.getConfiguration("zig").get<string>("path", "");
        if (!zigPath) return null;
        const result = resolveExePathAndVersion(zigPath, "version");
        if ("message" in result) {
            vscode.window
                .showErrorMessage(`Unexpected 'zig.path': ${result.message}`, "install Zig", "open settings")
                .then(async (response) => {
                    switch (response) {
                        case "install Zig":
                            await workspaceConfigUpdateNoThrow(
                                vscode.workspace.getConfiguration("zig"),
                                "path",
                                undefined,
                            );
                            break;
                        case "open settings":
                            await vscode.commands.executeCommand("workbench.action.openSettings", "zig.path");
                            break;
                        case undefined:
                            break;
                    }
                });
            return undefined;
        }
        return result;
    }
}
