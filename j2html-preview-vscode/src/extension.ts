import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
    const codeLensProvider = new PreviewCodeLensProvider();

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'java', scheme: 'file' },
            codeLensProvider,
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'j2html-preview.preview',
            (args: PreviewCommandArgs) => runPreview(args),
        ),
    );
}

export function deactivate(): void {
    // nothing to clean up
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PreviewCommandArgs {
    document: vscode.TextDocument;
    className: string;
    methodName: string;
}

// ---------------------------------------------------------------------------
// CodeLens provider
// ---------------------------------------------------------------------------

/**
 * Scans the active Java document for methods annotated with {@code @Preview}
 * and adds a "▶ Preview" CodeLens above each one.
 */
class PreviewCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        const packageMatch = text.match(/^package\s+([\w.]+)\s*;/m);
        const classMatch = text.match(/(?:public\s+)?(?:class|interface)\s+(\w+)/);

        if (!classMatch) {
            return lenses;
        }

        const simpleName = classMatch[1];
        const fullClassName = packageMatch
            ? `${packageMatch[1]}.${simpleName}`
            : simpleName;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed === '@Preview' || trimmed.startsWith('@Preview(')) {
                // Look ahead up to 5 lines for the method signature.
                for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
                    const methodMatch = lines[j].match(
                        // Matches a no-arg public/protected/private method declaration.
                        // Allows for complex return types (generics, arrays) and ignores
                        // additional annotations that may appear on the same line.
                        /(?:public|protected|private)\s+(?:(?:static|final|synchronized)\s+)*[\w<>[\],\s]+\s+(\w+)\s*\(\s*\)\s*(?:throws\s+[\w,\s]+)?\s*\{?/,
                    );
                    if (methodMatch) {
                        const methodName = methodMatch[1];
                        const range = new vscode.Range(i, 0, i, lines[i].length);
                        lenses.push(
                            new vscode.CodeLens(range, {
                                title: '▶ Preview',
                                command: 'j2html-preview.preview',
                                arguments: [
                                    {
                                        document,
                                        className: fullClassName,
                                        methodName,
                                    } satisfies PreviewCommandArgs,
                                ],
                            }),
                        );
                        break;
                    }
                }
            }
        }

        return lenses;
    }
}

// ---------------------------------------------------------------------------
// Preview execution
// ---------------------------------------------------------------------------

async function runPreview(args: PreviewCommandArgs): Promise<void> {
    const { document, className, methodName } = args;

    const projectRoot = findMavenRoot(document.uri.fsPath);
    if (!projectRoot) {
        vscode.window.showErrorMessage(
            'j2html Preview: Cannot find a Maven project root (pom.xml) for this file.',
        );
        return;
    }

    const previewName = `${methodName} – j2html Preview`;
    const panel = vscode.window.createWebviewPanel(
        'j2htmlPreview',
        previewName,
        vscode.ViewColumn.Beside,
        { enableScripts: false },
    );

    panel.webview.html = loadingHtml(methodName);

    try {
        // Compile test sources so the annotated method class is available.
        await execMaven(projectRoot, ['test-compile', '-q']);

        // Resolve the full runtime + test classpath via Maven.
        const classpath = await resolveClasspath(projectRoot);

        // Run the annotated method and capture its HTML output.
        const html = await runJavaMethod(projectRoot, classpath, className, methodName);

        panel.webview.html = html || '<p>(method returned no output)</p>';
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        panel.webview.html = errorHtml(message);
    }
}

// ---------------------------------------------------------------------------
// Maven helpers
// ---------------------------------------------------------------------------

/**
 * Walks up the directory tree looking for the nearest {@code pom.xml}.
 * Returns {@code null} when no pom.xml can be found.
 */
function findMavenRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    const root = path.parse(dir).root;

    while (dir !== root) {
        if (fs.existsSync(path.join(dir, 'pom.xml'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }

    return null;
}

function execMaven(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const mvn = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
        const proc = cp.spawn(mvn, args, { cwd, shell: false });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
        proc.stderr.on('data', (data: Buffer) => (stderr += data.toString()));

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`Maven exited with code ${code}:\n${stderr}`));
            }
        });
    });
}

/**
 * Asks Maven to resolve the full compile + test runtime classpath and returns
 * a colon/semicolon-separated string ready to pass to {@code java -cp}.
 */
async function resolveClasspath(projectRoot: string): Promise<string> {
    const cpFile = path.join(projectRoot, 'target', 'j2html-preview-classpath.txt');

    await execMaven(projectRoot, [
        'dependency:build-classpath',
        `-Dmdep.outputFile=${cpFile}`,
        '-Dmdep.includeScope=test',
        '-q',
    ]);

    const deps = fs.readFileSync(cpFile, 'utf-8').trim();
    const sep = process.platform === 'win32' ? ';' : ':';

    return [
        deps,
        path.join(projectRoot, 'target', 'classes'),
        path.join(projectRoot, 'target', 'test-classes'),
    ].join(sep);
}

// ---------------------------------------------------------------------------
// Java execution
// ---------------------------------------------------------------------------

function runJavaMethod(
    cwd: string,
    classpath: string,
    className: string,
    methodName: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(
            'java',
            ['-cp', classpath, 'com.teggr.j2html.preview.PreviewRunner', className, methodName],
            { cwd, shell: false },
        );

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
        proc.stderr.on('data', (data: Buffer) => (stderr += data.toString()));

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`PreviewRunner failed (exit ${code}):\n${stderr}`));
            }
        });
    });
}

// ---------------------------------------------------------------------------
// WebView HTML helpers
// ---------------------------------------------------------------------------

function loadingHtml(methodName: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>j2html Preview</title></head>
<body>
  <p>Building project and running <code>${escapeHtml(methodName)}()</code>&hellip;</p>
</body>
</html>`;
}

function errorHtml(message: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>j2html Preview – Error</title></head>
<body>
  <h3>Preview failed</h3>
  <pre style="white-space:pre-wrap;word-break:break-all">${escapeHtml(message)}</pre>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
