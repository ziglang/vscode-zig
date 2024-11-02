import childProcess from "child_process";
import fs from "fs";
import { getZigPath } from "./zigUtil";
import path from "path";
import util from "util";
import vscode from "vscode";

const execFile = util.promisify(childProcess.execFile);

export class ZigMainCodeLensProvider implements vscode.CodeLensProvider {
    public provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();

        const mainRegex = /pub\s+fn\s+main\s*\(/g;
        let match;
        while ((match = mainRegex.exec(text))) {
            const position = document.positionAt(match.index);
            const range = new vscode.Range(position, position);
            codeLenses.push(
                new vscode.CodeLens(range, { title: "Run", command: "zig.run", arguments: [document.uri.fsPath] }),
            );
            codeLenses.push(
                new vscode.CodeLens(range, { title: "Debug", command: "zig.debug", arguments: [document.uri.fsPath] }),
            );
        }
        return codeLenses;
    }

    public static registerCommands(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            vscode.commands.registerCommand("zig.run", zigRun),
            vscode.commands.registerCommand("zig.debug", zigDebug),
        );
    }
}

function zigRun(filePath: string) {
    const terminal = vscode.window.createTerminal("Run Zig Program");
    terminal.show();

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (workspaceFolder && hasBuildFile(workspaceFolder.uri.fsPath)) {
        terminal.sendText(`${getZigPath()} build run`);
        return;
    }
    terminal.sendText(`${getZigPath()} run "${filePath}"`);
}

function hasBuildFile(workspaceFspath: string): boolean {
    const buildZigPath = path.join(workspaceFspath, "build.zig");
    return fs.existsSync(buildZigPath);
}

async function zigDebug(filePath: string) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    let binaryPath = "";

    if (workspaceFolder && hasBuildFile(workspaceFolder.uri.fsPath)) {
        binaryPath = await buildDebugBinaryWithBuildFile(workspaceFolder.uri.fsPath);
    } else {
        binaryPath = filePath;
    }

    const debugConfig: vscode.DebugConfiguration = {
        type: "lldb",
        name: `Debug Zig`,
        request: "launch",
        program: binaryPath,
        cwd: path.dirname(workspaceFolder?.uri.fsPath ?? filePath),
        stopAtEntry: false,
    };
    await vscode.debug.startDebugging(undefined, debugConfig);
}

async function buildDebugBinaryWithBuildFile(workspacePath: string): Promise<string> {
    // Workaround because zig build doesn't support specifying the output binary name
    // `zig run` does support -femit-bin, but what if build file has custom build logic?
    const outputDir = path.join(workspacePath, "zig-out", "tmp-debug-build");
    const zigPath = getZigPath();
    await execFile(zigPath, ["build", "--prefix", outputDir], { cwd: workspacePath });
    const dirFiles = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(outputDir, "bin")));
    const files = dirFiles.find(([, type]) => type === vscode.FileType.File);
    if (!files) {
        throw new Error("Unable to build debug binary");
    }
    return path.join(outputDir, "bin", files[0]);
}
