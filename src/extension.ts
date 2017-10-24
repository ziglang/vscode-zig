'use strict';
import * as vscode from 'vscode';
import ZigCompilerProvider from './zigCompilerProvider';

export function activate(context: vscode.ExtensionContext) {
    let compiler = new ZigCompilerProvider();
    compiler.activate(context.subscriptions);
    vscode.languages.registerCodeActionsProvider('zig', compiler);
}

export function deactivate() {
}