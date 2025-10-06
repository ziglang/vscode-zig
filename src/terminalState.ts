/**
 * A status monitor for a VSCode terminal.
 */

import vscode from "vscode";

const terminalsState = new Map<vscode.Terminal, boolean>();

export function getTerminalState(terminal: vscode.Terminal): boolean | undefined {
    return terminalsState.get(terminal);
}

export function registerTerminalStateManagement(): void {
    vscode.window.onDidOpenTerminal((terminal) => {
        terminalsState.set(terminal, false);
    });
    vscode.window.onDidStartTerminalShellExecution((event) => {
        terminalsState.set(event.terminal, true);
    });
    vscode.window.onDidEndTerminalShellExecution((event) => {
        terminalsState.set(event.terminal, false);
    });
    vscode.window.onDidCloseTerminal((terminal) => {
        terminalsState.delete(terminal);
    });
}
