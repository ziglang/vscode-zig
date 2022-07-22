import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {window, workspace} from 'vscode';

export const isWindows = process.platform === 'win32';

/** Options for execCmd */
export interface ExecCmdOptions {
	/** The project root folder for this file is used as the cwd of the process */
	fileName?: string;
	/** Any arguments */
	cmdArguments?: string[];
	/** Shows a message if an error occurs (in particular the command not being */
	/* found), instead of rejecting. If this happens, the promise never resolves */
	showMessageOnError?: boolean;
	/** Called after the process successfully starts */
	onStart?: () => void;
	/** Called when data is sent to stdout */
	onStdout?: (data: string) => void;
	/** Called when data is sent to stderr */
	onStderr?: (data: string) => void;
	/** Called after the command (successfully or unsuccessfully) exits */
	onExit?: () => void;
	/** Text to add when command is not found (maybe helping how to install) */
	notFoundText?: string;
}

/** Type returned from execCmd. Is a promise for when the command completes
 *  and also a wrapper to access ChildProcess-like methods.
 */
export interface ExecutingCmd
	extends Promise<{stdout: string; stderr: string}> {
	/** The process's stdin */
	stdin: NodeJS.WritableStream;
	/** End the process */
	kill();
	/** Is the process running */
	// eslint-disable-next-line @typescript-eslint/member-ordering
	isRunning: boolean;
}

/** Executes a command. Shows an error message if the command isn't found */
export async function execCmd(cmd: string, options: ExecCmdOptions = {}) {
	const {fileName, onStart, onStdout, onStderr, onExit, cmdArguments} = options;
	let childProcess: cp.ChildProcess;
	let firstResponse = true;
	let wasKilledbyUs = false;

	const executingCmd: any = new Promise((resolve, reject) => {
		const cmdArguments = options ? options.cmdArguments : [];

		childProcess = cp.exec(
			cmd + ' ' + (cmdArguments || []).join(' '),
			{
				cwd: detectProjectRoot(
					fileName || workspace.rootPath + '/fakeFileName',
				),
				maxBuffer: 10 * 1024 * 1024,
			},
			handleExit,
		);

		childProcess.stdout.on('data', (data: string) => {
			if (firstResponse && onStart) {
				onStart();
			}

			firstResponse = false;
			if (onStdout) {
				onStdout(data.toString());
			}
		});

		childProcess.stderr.on('data', (data: string) => {
			if (firstResponse && onStart) {
				onStart();
			}

			firstResponse = false;
			if (onStderr) {
				onStderr(data.toString());
			}
		});

		function handleExit(error: Error, stdout: string, stderr: string) {
			executingCmd.isRunning = false;
			if (onExit) {
				onExit();
			}

			if (!wasKilledbyUs) {
				if (error) {
					if (options.showMessageOnError) {
						const cmdName = cmd.split(' ', 1)[0];
						const cmdWasNotFound =
							// Windows method apparently still works on non-English systems
							(isWindows &&
								error.message.includes(`'${cmdName}' is not recognized`)) ||
							(!isWindows && (error as any).code === 127);

						if (cmdWasNotFound) {
							const notFoundText = options ? options.notFoundText : '';
							void window.showErrorMessage(
								`${cmdName} is not available in your path. ` + notFoundText,
							);
						} else {
							void window.showErrorMessage(error.message);
						}
					} else {
						reject(error);
					}
				} else {
					resolve({stdout, stderr});
				}
			}
		}
	});

	executingCmd.stdin = childProcess.stdin;
	executingCmd.kill = killProcess;
	executingCmd.isRunning = true;

	return executingCmd as ExecutingCmd;

	function killProcess() {
		wasKilledbyUs = true;
		if (isWindows) {
			cp.spawn('taskkill', ['/pid', childProcess.pid.toString(), '/f', '/t']);
		} else {
			childProcess.kill('SIGINT');
		}
	}
}

const buildFile = 'build.zig';

export function findProj(dir: string, parent: string): string {
	if (dir === '' || dir === parent) {
		return '';
	}

	if (fs.lstatSync(dir).isDirectory()) {
		const build = path.join(dir, buildFile);
		if (fs.existsSync(build)) {
			return dir;
		}
	}

	return findProj(path.dirname(dir), dir);
}

export function detectProjectRoot(fileName: string): string {
	const proj = findProj(path.dirname(fileName), '');
	if (proj !== '') {
		return proj;
	}

	return undefined;
}
