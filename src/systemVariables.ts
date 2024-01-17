
import * as Path from 'path';
import { Range, Uri, workspace, window } from 'vscode';

/*---------------------------------------------------------------------------------------------
 *  Derived from https://github.com/microsoft/vscode-python/blob/2f3102fe0bb007df0d80276f488c2d0257f4f3b1/src/client/common/variables/systemVariables.ts
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 * 
 *  MIT License
 *  
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *  
 *  The above copyright notice and this permission notice shall be included in all
 *  copies or substantial portions of the Software.
 *  
 *  THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 *--------------------------------------------------------------------------------------------*/

class Types {
    static isString(value: any): value is string {
        return typeof value === 'string';
    }
    static isArray(value: any): value is any[] {
        return Array.isArray(value);
    }
    static isObject(value: any): value is object {
        return typeof value === 'object' && value !== null;
    }

}
export class SystemVariables {

    public resolveString(value: string): string {
        const regexp = /\$\{(.*?)\}/g;
        return value.replace(regexp, (match: string, name: string) => {
            const newValue = (<any>this)[name];
            if (Types.isString(newValue)) {
                return newValue;
            } else {
                return match && (match.indexOf('env.') > 0 || match.indexOf('env:') > 0) ? '' : match;
            }
        });
    }

    private _workspaceFolder: string;
    private _workspaceFolderName: string;
    private _filePath: string | undefined;
    private _lineNumber: number | undefined;
    private _selectedText: string | undefined;
    private _execPath: string;

    constructor(
        file: Uri | undefined,
        rootFolder: string | undefined,
    ) {
        const workspaceFolder = workspace && file ? workspace.getWorkspaceFolder(file) : undefined;
        this._workspaceFolder = workspaceFolder ? workspaceFolder.uri.fsPath : rootFolder || __dirname;
        this._workspaceFolderName = Path.basename(this._workspaceFolder);
        this._filePath = file ? file.fsPath : undefined;

        if (window && window.activeTextEditor) {
            this._lineNumber = window.activeTextEditor.selection.anchor.line + 1;
            this._selectedText = window.activeTextEditor.document.getText(
                new Range(
                    window.activeTextEditor.selection.start,
                    window.activeTextEditor.selection.end,
                ),
            );
        }
        this._execPath = process.execPath;
        Object.keys(process.env).forEach((key) => {
            ((this as any) as Record<string, string | undefined>)[`env:${key}`] = ((this as any) as Record<
                string,
                string | undefined
            >)[`env.${key}`] = process.env[key];
        });
        try {
            workspace.workspaceFolders.forEach((folder) => {
                const basename = Path.basename(folder.uri.fsPath);
                ((this as any) as Record<string, string | undefined>)[`workspaceFolder:${basename}`] =
                    folder.uri.fsPath;
                ((this as any) as Record<string, string | undefined>)[`workspaceFolder:${folder.name}`] =
                    folder.uri.fsPath;
            });
        } catch {
            // This try...catch block is here to support pre-existing tests, ignore error.
        }
    }

    public get cwd(): string {
        return this.workspaceFolder;
    }

    public get workspaceRoot(): string {
        return this._workspaceFolder;
    }

    public get workspaceFolder(): string {
        return this._workspaceFolder;
    }

    public get workspaceRootFolderName(): string {
        return this._workspaceFolderName;
    }

    public get workspaceFolderBasename(): string {
        return this._workspaceFolderName;
    }

    public get file(): string | undefined {
        return this._filePath;
    }

    public get relativeFile(): string | undefined {
        return this.file ? Path.relative(this._workspaceFolder, this.file) : undefined;
    }

    public get relativeFileDirname(): string | undefined {
        return this.relativeFile ? Path.dirname(this.relativeFile) : undefined;
    }

    public get fileBasename(): string | undefined {
        return this.file ? Path.basename(this.file) : undefined;
    }

    public get fileBasenameNoExtension(): string | undefined {
        return this.file ? Path.parse(this.file).name : undefined;
    }

    public get fileDirname(): string | undefined {
        return this.file ? Path.dirname(this.file) : undefined;
    }

    public get fileExtname(): string | undefined {
        return this.file ? Path.extname(this.file) : undefined;
    }

    public get lineNumber(): number | undefined {
        return this._lineNumber;
    }

    public get selectedText(): string | undefined {
        return this._selectedText;
    }

    public get execPath(): string {
        return this._execPath;
    }
}