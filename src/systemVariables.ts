
import * as Path from 'path';
import { Range, Uri, workspace, window } from 'vscode';

type IStringDictionary<T> = { [P in string]?: T};
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// https://github.com/microsoft/vscode-python/blob/main/src/client/common/variables/systemVariables.ts
// FIXME: Include MIT license

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
abstract class AbstractSystemVariables  {
    public resolve(value: string): string;
    public resolve(value: string[]): string[];
    public resolve(value: IStringDictionary<string>): IStringDictionary<string>;
    public resolve(value: IStringDictionary<string[]>): IStringDictionary<string[]>;
    public resolve(value: IStringDictionary<IStringDictionary<string>>): IStringDictionary<IStringDictionary<string>>;

    public resolve(value: any): any {
        if (Types.isString(value)) {
            return this.__resolveString(value);
        } else if (Types.isArray(value)) {
            return this.__resolveArray(value);
        } else if (Types.isObject(value)) {
            return this.__resolveLiteral(value);
        }

        return value;
    }

    public resolveAny<T>(value: T): T;

    public resolveAny(value: any): any {
        if (Types.isString(value)) {
            return this.__resolveString(value);
        } else if (Types.isArray(value)) {
            return this.__resolveAnyArray(value);
        } else if (Types.isObject(value)) {
            return this.__resolveAnyLiteral(value);
        }

        return value;
    }

    private __resolveString(value: string): string {
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

    private __resolveLiteral(
        values: IStringDictionary<string | IStringDictionary<string> | string[]>,
    ): IStringDictionary<string | IStringDictionary<string> | string[]> {
        const result: IStringDictionary<string | IStringDictionary<string> | string[]> = Object.create(null);
        Object.keys(values).forEach((key) => {
            const value = values[key];

            result[key] = <any>this.resolve(<any>value);
        });
        return result;
    }

    private __resolveAnyLiteral<T>(values: T): T;

    private __resolveAnyLiteral(values: any): any {
        const result: IStringDictionary<string | IStringDictionary<string> | string[]> = Object.create(null);
        Object.keys(values).forEach((key) => {
            const value = values[key];

            result[key] = <any>this.resolveAny(<any>value);
        });
        return result;
    }

    private __resolveArray(value: string[]): string[] {
        return value.map((s) => this.__resolveString(s));
    }

    private __resolveAnyArray<T>(value: T[]): T[];

    private __resolveAnyArray(value: any[]): any[] {
        return value.map((s) => this.resolveAny(s));
    }
}

export class SystemVariables extends AbstractSystemVariables {
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
        super();
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
            workspace.workspaceFolders?.forEach((folder) => {
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