import vscode from "vscode";

import semver from "semver";

import { resolveExePathAndVersion } from "./zigUtil";

interface ExeWithVersion {
    exe: string;
    version: semver.SemVer;
}

export class ZigProvider implements vscode.Disposable {
    onChange: vscode.EventEmitter<ExeWithVersion | null> = new vscode.EventEmitter();
    private value: ExeWithVersion | null;
    private disposables: vscode.Disposable[];

    constructor() {
        this.value = this.resolveZigPathConfigOption();
        this.disposables = [
            vscode.workspace.onDidChangeConfiguration((change) => {
                if (change.affectsConfiguration("zig.path")) {
                    const newValue = this.resolveZigPathConfigOption();
                    if (newValue) {
                        this.set(this.value);
                    }
                }
            }),
        ];
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
        this.value = value;
        this.onChange.fire(value);
    }

    /**
     * Set the path the Zig executable. Will be saved in `zig.path` config option.
     *
     * @param zigPath The path to the zig executable. If `null`, the `zig.path` config option will be removed.
     */
    public async setAndSave(zigPath: string | null) {
        if (!zigPath) {
            await vscode.workspace.getConfiguration("zig").update("path", undefined, true);
            return;
        }
        const newValue = this.resolveZigPathConfigOption(zigPath);
        if (!newValue) return;
        await vscode.workspace.getConfiguration("zig").update("path", newValue.exe, true);
        this.set(newValue);
    }

    /** Resolves the `zig.path` configuration option */
    private resolveZigPathConfigOption(zigPath?: string): ExeWithVersion | null {
        zigPath ??= vscode.workspace.getConfiguration("zig").get<string>("path", "");
        if (!zigPath) return null;
        const exePath = zigPath !== "zig" ? zigPath : null; // the string "zig" means lookup in PATH
        const result = resolveExePathAndVersion(exePath, "zig", "zig.path", "version");
        if ("message" in result) {
            void vscode.window.showErrorMessage(result.message);
            return null;
        }
        return result;
    }

    dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
