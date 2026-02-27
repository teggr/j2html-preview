import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Preview tracking
// ---------------------------------------------------------------------------

/**
 * Metadata for an active preview panel.
 */
interface ActivePreview {
    panel: vscode.WebviewPanel;
    document: vscode.TextDocument;
    className: string;
    methodName: string;
    projectRoot: string;
}

/**
 * Maps preview key (documentUri#methodName) to active preview metadata.
 */
const activePreviews = new Map<string, ActivePreview>();

/**
 * Maps preview key to pending debounce timer.
 */
const debounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Default debounce delay in milliseconds for auto-reload.
 */
const DEBOUNCE_DELAY_MS = 500;

/**
 * Generates a unique key for a preview panel.
 */
function getPreviewKey(documentUri: string, methodName: string): string {
    return `${documentUri}#${methodName}`;
}

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
            (args: PreviewCommandArgs) => runPreview(context, args),
        ),
    );

    // Watch for Java and CSS file changes to auto-reload previews.
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{java,css}');
    
    fileWatcher.onDidChange((uri) => {
        handleFileChange(uri);
    });

    context.subscriptions.push(fileWatcher);

    // Close preview panels when their source editor is closed.
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            handleVisibleEditorsChange(editors);
        }),
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
        // Match class/interface declarations at the start of a line (not in comments)
        const classMatch = text.match(/^(?:public\s+)?(?:class|interface)\s+(\w+)/m);

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

async function runPreview(context: vscode.ExtensionContext, args: PreviewCommandArgs): Promise<void> {
    const { document, className, methodName } = args;

    const projectRoot = findMavenRoot(document.uri.fsPath);
    if (!projectRoot) {
        vscode.window.showErrorMessage(
            'j2html Preview: Cannot find a Maven project root (pom.xml) for this file.',
        );
        return;
    }

    // Reuse the existing preview panel if one is already open for this method.
    const previewKey = getPreviewKey(document.uri.toString(), methodName);
    const existing = activePreviews.get(previewKey);
    if (existing) {
        existing.panel.reveal(vscode.ViewColumn.Beside);
        await refreshPreview(previewKey);
        return;
    }

    const previewName = `${methodName} – j2html Preview`;
    const panel = vscode.window.createWebviewPanel(
        'j2htmlPreview',
        previewName,
        vscode.ViewColumn.Beside,
        { 
            enableScripts: false,
            localResourceRoots: [vscode.Uri.file(projectRoot)]
        },
    );

    // Register this preview for auto-reload.
    activePreviews.set(previewKey, {
        panel,
        document,
        className,
        methodName,
        projectRoot,
    });

    // Clean up when the panel is disposed.
    panel.onDidDispose(() => {
        activePreviews.delete(previewKey);
        const timer = debounceTimers.get(previewKey);
        if (timer) {
            clearTimeout(timer);
            debounceTimers.delete(previewKey);
        }
    });

    // Perform the initial preview refresh.
    await refreshPreview(previewKey);
}

/**
 * Refreshes the preview panel by recompiling and re-running the Java method.
 */
async function refreshPreview(previewKey: string): Promise<void> {
    const preview = activePreviews.get(previewKey);
    if (!preview) {
        return;
    }

    const { panel, className, methodName, projectRoot } = preview;

    panel.webview.html = await loadingHtml(panel, projectRoot, methodName);

    try {
        // Compile test sources so the annotated method class is available.
        await execMaven(projectRoot, ['test-compile', '-q']);

        // Resolve the full runtime + test classpath via Maven.
        const classpath = await resolveClasspath(projectRoot);

        // Run the annotated method and capture its HTML output.
        const html = await runJavaMethod(projectRoot, classpath, className, methodName);

        // Process the HTML and inject CSS
        const processedHtml = await processHtmlWithCss(
            panel,
            projectRoot,
            html || '<p>(method returned no output)</p>'
        );

        panel.webview.html = processedHtml;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        panel.webview.html = await errorHtml(panel, projectRoot, message);
    }
}

/**
 * Handles a file change event and triggers debounced refresh for affected previews.
 */
function handleFileChange(uri: vscode.Uri): void {
    const uriString = uri.toString();

    // Check which active previews are affected by this file change.
    for (const [previewKey, preview] of activePreviews) {
        // Refresh if the changed file matches the preview's document.
        if (preview.document.uri.toString() === uriString) {
            // Clear any existing debounce timer.
            const existingTimer = debounceTimers.get(previewKey);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            // Set a new debounce timer.
            const timer = setTimeout(() => {
                debounceTimers.delete(previewKey);
                refreshPreview(previewKey);
            }, DEBOUNCE_DELAY_MS);

            debounceTimers.set(previewKey, timer);
        }
    }
}

/**
 * Closes preview panels when their source document is no longer visible in any editor.
 */
function handleVisibleEditorsChange(editors: readonly vscode.TextEditor[]): void {
    // Build a set of currently visible document URIs for fast lookup.
    const visibleDocumentUris = new Set(
        editors.map((editor) => editor.document.uri.toString()),
    );

    // Collect previews to close (avoid modifying Map during iteration).
    const previewsToClose: vscode.WebviewPanel[] = [];

    for (const [previewKey, preview] of activePreviews) {
        // Check if the preview's document is still visible in any editor.
        if (!visibleDocumentUris.has(preview.document.uri.toString())) {
            previewsToClose.push(preview.panel);
        }
    }

    // Dispose the panels. The onDidDispose handler will clean up the Maps.
    for (const panel of previewsToClose) {
        panel.dispose();
    }
}

// ---------------------------------------------------------------------------
// CSS helpers
// ---------------------------------------------------------------------------

interface CssConfiguration {
    cssFiles: string[];
    inlineStyles: string;
}

/**
 * Reads CSS configuration from VS Code settings.
 */
function getCssConfiguration(): CssConfiguration {
    const config = vscode.workspace.getConfiguration('j2html-preview');
    return {
        cssFiles: config.get<string[]>('cssFiles') || ['src/main/resources/static/styles.css'],
        inlineStyles: config.get<string>('inlineStyles') || '',
    };
}

/**
 * Resolves CSS files from glob patterns, local paths, or URLs and converts them to webview URIs.
 * Returns an array of <link> tag strings.
 */
async function resolveCssFiles(panel: vscode.WebviewPanel, projectRoot: string): Promise<string[]> {
    const config = getCssConfiguration();
    const cssLinks: string[] = [];

    for (const pattern of config.cssFiles) {
        // Check if this is an external URL
        if (pattern.startsWith('http://') || pattern.startsWith('https://')) {
            cssLinks.push(`<link rel="stylesheet" href="${pattern}">`);
            continue;
        }

        const fullPath = path.join(projectRoot, pattern);
        
        // Check if this is a direct file path (not a glob)
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const cssUri = panel.webview.asWebviewUri(vscode.Uri.file(fullPath));
            cssLinks.push(`<link rel="stylesheet" href="${cssUri}">`);
        } else {
            // It might be a glob pattern - use VS Code's file search
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(projectRoot, pattern),
                '**/node_modules/**',
                100
            );
            
            for (const fileUri of files) {
                const cssUri = panel.webview.asWebviewUri(fileUri);
                cssLinks.push(`<link rel="stylesheet" href="${cssUri}">`);
            }
        }
    }

    return cssLinks;
}

/**
 * Processes HTML content by injecting CSS links and inline styles.
 * Detects whether HTML is a fragment or full document and handles accordingly.
 */
async function processHtmlWithCss(
    panel: vscode.WebviewPanel,
    projectRoot: string,
    html: string
): Promise<string> {
    const cssLinks = await resolveCssFiles(panel, projectRoot);
    const config = getCssConfiguration();
    
    // Build CSS injection content
    const cssContent = [
        ...cssLinks,
        config.inlineStyles ? `<style>${config.inlineStyles}</style>` : '',
    ].filter(Boolean).join('\n    ');

    if (!cssContent) {
        return html; // No CSS to inject
    }

    // Detect if this is a full HTML document or a fragment
    const isFullDocument = /<html[>\s]/i.test(html) || /<head[>\s]/i.test(html);

    if (!isFullDocument) {
        // Fragment: wrap in a full HTML template with CSS
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${cssContent}
</head>
<body>
    ${html}
</body>
</html>`;
    }

    // Full document: inject CSS into the <head> section
    const headMatch = html.match(/<head[^>]*>/i);
    if (headMatch) {
        const headEndIndex = headMatch.index! + headMatch[0].length;
        return html.slice(0, headEndIndex) + '\n    ' + cssContent + html.slice(headEndIndex);
    }

    // Fallback: try to inject before </head>
    return html.replace(/(<\/head>)/i, `    ${cssContent}\n$1`);
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
        // On Windows, use shell: true to properly execute .cmd files
        const useShell = process.platform === 'win32';
        const proc = cp.spawn(mvn, args, { cwd, shell: useShell });

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

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn Maven process: ${err.message}`));
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
        // Create a temporary argument file to avoid Windows command line length limits
        const argFile = path.join(cwd, 'target', '.j2html-preview-args.txt');
        
        try {
            // Write classpath and arguments to the file (one argument per line)
            // On Windows, we must not quote the classpath when it contains semicolons
            // Java argument files handle spaces in paths correctly without quotes
            const argFileContent = `-cp\n${classpath}\ncom.teggr.j2html.preview.PreviewRunner\n${className}\n${methodName}`;
            fs.writeFileSync(argFile, argFileContent, 'utf-8');
        } catch (writeErr) {
            reject(new Error(`Failed to write argument file: ${writeErr}`));
            return;
        }
        
        // On Windows, use shell: true to handle paths properly
        const useShell = process.platform === 'win32';
        
        const proc = cp.spawn(
            'java',
            [`@${argFile}`],
            { cwd, shell: useShell },
        );

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
        proc.stderr.on('data', (data: Buffer) => (stderr += data.toString()));

        proc.on('close', (code) => {
            // Clean up the temporary argument file
            try {
                if (fs.existsSync(argFile)) {
                    fs.unlinkSync(argFile);
                }
            } catch (cleanupErr) {
                // Ignore cleanup errors
            }
            
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`PreviewRunner failed (exit ${code}):\n${stderr}`));
            }
        });
        
        proc.on('error', (err) => {
            // Clean up the temporary argument file on error
            try {
                if (fs.existsSync(argFile)) {
                    fs.unlinkSync(argFile);
                }
            } catch (cleanupErr) {
                // Ignore cleanup errors
            }
            reject(new Error(`Failed to spawn Java process: ${err.message}`));
        });
    });
}

// ---------------------------------------------------------------------------
// WebView HTML helpers
// ---------------------------------------------------------------------------

async function loadingHtml(panel: vscode.WebviewPanel, projectRoot: string, methodName: string): Promise<string> {
    const cssLinks = await resolveCssFiles(panel, projectRoot);
    const cssContent = cssLinks.join('\n    ');
    
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>j2html Preview</title>
    ${cssContent}
</head>
<body>
  <p>Building project and running <code>${escapeHtml(methodName)}()</code>&hellip;</p>
</body>
</html>`;
}

async function errorHtml(panel: vscode.WebviewPanel, projectRoot: string, message: string): Promise<string> {
    const cssLinks = await resolveCssFiles(panel, projectRoot);
    const cssContent = cssLinks.join('\n    ');
    
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>j2html Preview – Error</title>
    ${cssContent}
</head>
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
