import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { resolveJavaExtensionClasspath } from './javaExtension';
import {
    discoverPreviewTargets,
    discoverPreviewTargetsWithRegexFallback,
    type PreviewSymbolNode,
} from './previewDiscovery';
import {
    applyJavaInvalidation,
    applyPomInvalidation,
    normalizeBuildStrategy,
    resolverOrder,
    type RuntimeSettings,
} from './runtimePolicy';

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
    lastRenderedHtml?: string;
    refreshToken: number;
}

/**
 * Maps preview key (documentUri#methodName) to active preview metadata.
 */
const activePreviews = new Map<string, ActivePreview>();

/**
 * Maps preview key to pending debounce timer.
 */
const debounceTimers = new Map<string, { timer: NodeJS.Timeout; mode: RefreshMode }>();

/**
 * Tracks whether a project's compiled output or resolved classpath is stale.
 */
interface ProjectState {
    needsCompile: boolean;
    needsClasspathRefresh: boolean;
    cachedClasspath?: string;
}

const projectStates = new Map<string, ProjectState>();

type RefreshMode = 'full' | 'css-only';

let nextRefreshToken = 0;

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

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'j2html-preview.showDiagnostics',
            () => showDiagnostics(),
        ),
    );

    // Watch for Java and CSS file changes to auto-reload previews.
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{java,css}');
    const pomWatcher = vscode.workspace.createFileSystemWatcher('**/pom.xml');
    
    fileWatcher.onDidChange((uri) => {
        handleFileChange(uri);
    });

    pomWatcher.onDidChange((uri) => {
        handleFileChange(uri);
    });

    context.subscriptions.push(fileWatcher);
    context.subscriptions.push(pomWatcher);

    // Close preview panels when their source document is closed.
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            handleDocumentClose(document);
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
    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const text = document.getText();
        const symbols = await getJavaDocumentSymbols(document.uri);
        const previewTargets = discoverPreviewTargets(text, symbols);
        const resolvedTargets = previewTargets.length > 0
            ? previewTargets
            : discoverPreviewTargetsWithRegexFallback(text);

        return resolvedTargets.map((target) => {
            const lineText = document.lineAt(target.annotationLine).text;
            return new vscode.CodeLens(
                new vscode.Range(target.annotationLine, 0, target.annotationLine, lineText.length),
                {
                    title: '▶ Preview',
                    command: 'j2html-preview.preview',
                    arguments: [
                        {
                            document,
                            className: target.className,
                            methodName: target.methodName,
                        } satisfies PreviewCommandArgs,
                    ],
                },
            );
        });
    }
}

async function getJavaDocumentSymbols(documentUri: vscode.Uri): Promise<PreviewSymbolNode[]> {
    try {
        const result = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
            'vscode.executeDocumentSymbolProvider',
            documentUri,
        );

        if (!result?.length) {
            return [];
        }

        const first = result[0];
        if ('location' in first) {
            return mapSymbolInformation(result as vscode.SymbolInformation[]);
        }

        return mapDocumentSymbols(result as vscode.DocumentSymbol[]);
    } catch {
        return [];
    }
}

function mapDocumentSymbols(symbols: vscode.DocumentSymbol[]): PreviewSymbolNode[] {
    return symbols
        .map((symbol) => {
            const kind = mapSymbolKind(symbol.kind);
            if (!kind) {
                return undefined;
            }

            return {
                kind,
                name: symbol.name,
                startLine: symbol.range.start.line,
                selectionStartLine: symbol.selectionRange.start.line,
                children: mapDocumentSymbols(symbol.children),
            } satisfies PreviewSymbolNode;
        })
        .filter((symbol): symbol is PreviewSymbolNode => Boolean(symbol));
}

function mapSymbolInformation(symbols: vscode.SymbolInformation[]): PreviewSymbolNode[] {
    const classNodes = new Map<string, PreviewSymbolNode>();

    for (const symbol of symbols) {
        const kind = mapSymbolKind(symbol.kind);
        if (!kind) {
            continue;
        }

        if (kind === 'class' || kind === 'interface') {
            const key = symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
            const classNode: PreviewSymbolNode = {
                kind,
                name: symbol.name,
                startLine: symbol.location.range.start.line,
                selectionStartLine: symbol.location.range.start.line,
                children: [],
            };

            classNodes.set(key, classNode);
            classNodes.set(symbol.name, classNode);
            continue;
        }

        if (kind !== 'method' || !symbol.containerName) {
            continue;
        }

        let parent = classNodes.get(symbol.containerName);
        if (!parent) {
            parent = [...classNodes.values()].find(
                (candidate) => candidate.name === symbol.containerName,
            );
        }
        if (!parent) {
            continue;
        }

        parent.children.push({
            kind,
            name: symbol.name,
            startLine: symbol.location.range.start.line,
            selectionStartLine: symbol.location.range.start.line,
            children: [],
        });
    }

    return [...classNodes.values()];
}

function mapSymbolKind(kind: vscode.SymbolKind): PreviewSymbolNode['kind'] | undefined {
    switch (kind) {
        case vscode.SymbolKind.Class:
            return 'class';
        case vscode.SymbolKind.Interface:
            return 'interface';
        case vscode.SymbolKind.Method:
            return 'method';
        default:
            return undefined;
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
        refreshToken: 0,
    });

    // Clean up when the panel is disposed.
    panel.onDidDispose(() => {
        activePreviews.delete(previewKey);
        const pendingRefresh = debounceTimers.get(previewKey);
        if (pendingRefresh) {
            clearTimeout(pendingRefresh.timer);
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
    await refreshPreviewWithMode(previewKey, 'full');
}

async function refreshPreviewWithMode(previewKey: string, mode: RefreshMode): Promise<void> {
    const preview = activePreviews.get(previewKey);
    if (!preview) {
        return;
    }

    const refreshToken = ++nextRefreshToken;
    preview.refreshToken = refreshToken;

    const title = mode === 'css-only'
        ? `Refreshing ${preview.methodName} preview styles`
        : `Refreshing ${preview.methodName} preview`;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title,
        },
        async () => refreshPreviewInternal(previewKey, refreshToken, mode),
    );
}

async function refreshPreviewInternal(
    previewKey: string,
    refreshToken: number,
    mode: RefreshMode,
): Promise<void> {
    const preview = activePreviews.get(previewKey);
    if (!preview || !isRefreshCurrent(previewKey, refreshToken)) {
        return;
    }

    const { panel, className, methodName, projectRoot } = preview;

    if (mode === 'full') {
        panel.webview.html = await loadingHtml(panel, projectRoot, methodName);
    }

    try {
        if (mode === 'full') {
            // Compile test sources so the annotated method class is available.
            await ensureProjectCompiled(preview.document.uri, projectRoot);
            if (!isRefreshCurrent(previewKey, refreshToken)) {
                return;
            }

            // Resolve the full runtime + test classpath via Maven.
            const classpath = await resolveClasspath(preview.document.uri, projectRoot);
            if (!isRefreshCurrent(previewKey, refreshToken)) {
                return;
            }

            // Run the annotated method and capture its HTML output.
            const html = await runJavaMethod(projectRoot, classpath, className, methodName);
            if (!isRefreshCurrent(previewKey, refreshToken)) {
                return;
            }

            preview.lastRenderedHtml = html || '<p>(method returned no output)</p>';
        }

        const htmlToRender = preview.lastRenderedHtml || '<p>(method returned no output)</p>';

        // Process the HTML and inject CSS
        const processedHtml = await processHtmlWithCss(
            panel,
            projectRoot,
            htmlToRender,
        );

        if (!isRefreshCurrent(previewKey, refreshToken)) {
            return;
        }

        panel.webview.html = processedHtml;
    } catch (err: unknown) {
        if (!isRefreshCurrent(previewKey, refreshToken)) {
            return;
        }

        const message = err instanceof Error ? err.message : String(err);
        panel.webview.html = await errorHtml(panel, projectRoot, message);
    }
}

/**
 * Handles a file change event and triggers debounced refresh for affected previews.
 */
function handleFileChange(uri: vscode.Uri): void {
    const runtimeSettings = getRuntimeSettings();
    const uriString = uri.toString();
    const filePath = uri.fsPath;
    const lowerFilePath = filePath.toLowerCase();
    const isCssFile = lowerFilePath.endsWith('.css');
    const isJavaFile = lowerFilePath.endsWith('.java');
    const isPomFile = path.basename(lowerFilePath) === 'pom.xml';

    // Check which active previews are affected by this file change.
    for (const [previewKey, preview] of activePreviews) {
        const belongsToProject = isPathWithinProject(filePath, preview.projectRoot);
        if (!belongsToProject) {
            continue;
        }

        if (isPomFile) {
            const projectState = getProjectState(preview.projectRoot);
            applyPomInvalidation(projectState);
            debugLog(runtimeSettings, `Detected pom.xml change, invalidating compile/classpath for ${preview.projectRoot}`);
            schedulePreviewRefresh(previewKey, 'full');
            continue;
        }

        if (isCssFile) {
            schedulePreviewRefresh(previewKey, 'css-only');
            continue;
        }

        if (isJavaFile) {
            const projectState = getProjectState(preview.projectRoot);
            applyJavaInvalidation(projectState);
            debugLog(runtimeSettings, `Detected Java source change, invalidating compile cache for ${preview.projectRoot}`);

            // Only auto-run the preview method again when the source file changed.
            if (preview.document.uri.toString() === uriString) {
                schedulePreviewRefresh(previewKey, 'full');
            }
        }
    }
}

function schedulePreviewRefresh(previewKey: string, mode: RefreshMode): void {
    const existing = debounceTimers.get(previewKey);
    let nextMode = mode;

    if (existing) {
        clearTimeout(existing.timer);
        if (existing.mode === 'full' || mode === 'full') {
            nextMode = 'full';
        }
    }

    const timer = setTimeout(() => {
        debounceTimers.delete(previewKey);
        void refreshPreviewWithMode(previewKey, nextMode);
    }, DEBOUNCE_DELAY_MS);

    debounceTimers.set(previewKey, { timer, mode: nextMode });
}

function isRefreshCurrent(previewKey: string, refreshToken: number): boolean {
    return activePreviews.get(previewKey)?.refreshToken === refreshToken;
}

function isPathWithinProject(filePath: string, projectRoot: string): boolean {
    const relativePath = path.relative(projectRoot, filePath);
    return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function getProjectState(projectRoot: string): ProjectState {
    let state = projectStates.get(projectRoot);
    if (!state) {
        state = {
            needsCompile: true,
            needsClasspathRefresh: true,
        };
        projectStates.set(projectRoot, state);
    }

    return state;
}

/**
 * Closes preview panels when their source document is closed.
 */
function handleDocumentClose(document: vscode.TextDocument): void {
    const documentUri = document.uri.toString();

    // Collect previews to close (avoid modifying Map during iteration).
    const previewsToClose: vscode.WebviewPanel[] = [];

    for (const [previewKey, preview] of activePreviews) {
        // Check if this preview belongs to the closed document.
        if (preview.document.uri.toString() === documentUri) {
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
 * Resolves the full compile + test runtime classpath via the Java extension and
 * returns a colon/semicolon-separated string ready to pass to {@code java -cp}.
 */
async function resolveClasspath(documentUri: vscode.Uri, projectRoot: string): Promise<string> {
    const projectState = getProjectState(projectRoot);
    if (projectState.cachedClasspath && !projectState.needsClasspathRefresh) {
        return projectState.cachedClasspath;
    }

    const runtimeSettings = getRuntimeSettings();
    const sep = process.platform === 'win32' ? ';' : ':';
    let classpathEntries: string[] | undefined;
    const failures: string[] = [];

    for (const resolver of resolverOrder(runtimeSettings.buildStrategy)) {
        try {
            if (resolver === 'java') {
                classpathEntries = await resolveJavaExtensionClasspath(documentUri, projectRoot);
            } else {
                classpathEntries = await resolveMavenClasspathEntries(projectRoot);
            }

            debugLog(runtimeSettings, `Resolved classpath using ${resolver} strategy.`);
            break;
        } catch (err: unknown) {
            const message = toErrorMessage(err);
            failures.push(`${resolver}: ${message}`);
            debugLog(runtimeSettings, `Classpath resolver ${resolver} failed: ${message}`);
        }
    }

    if (!classpathEntries) {
        throw new Error(`Classpath resolution failed (${runtimeSettings.buildStrategy}): ${failures.join(' | ')}`);
    }

    const classpath = classpathEntries.join(sep);

    projectState.cachedClasspath = classpath;
    projectState.needsClasspathRefresh = false;

    return classpath;
}

async function resolveMavenClasspathEntries(projectRoot: string): Promise<string[]> {
    const cpFile = path.join(projectRoot, 'target', 'j2html-preview-classpath.txt');

    await execMaven(projectRoot, [
        'dependency:build-classpath',
        `-Dmdep.outputFile=${cpFile}`,
        '-Dmdep.includeScope=test',
        '-q',
    ]);

    const deps = fs
        .readFileSync(cpFile, 'utf-8')
        .trim()
        .split(path.delimiter)
        .filter(Boolean);

    return [
        ...deps,
        path.join(projectRoot, 'target', 'classes'),
        path.join(projectRoot, 'target', 'test-classes'),
    ];
}

async function ensureProjectCompiled(documentUri: vscode.Uri, projectRoot: string): Promise<void> {
    const projectState = getProjectState(projectRoot);
    if (!projectState.needsCompile) {
        return;
    }

    const runtimeSettings = getRuntimeSettings();
    const failures: string[] = [];
    let compiled = false;

    for (const resolver of resolverOrder(runtimeSettings.buildStrategy)) {
        try {
            if (resolver === 'java') {
                await compileProjectWithJavaExtension(documentUri);
            } else {
                await compileProjectWithMaven(projectRoot);
            }

            debugLog(runtimeSettings, `Compiled project using ${resolver} strategy.`);
            compiled = true;
            break;
        } catch (err: unknown) {
            const message = toErrorMessage(err);
            failures.push(`${resolver}: ${message}`);
            debugLog(runtimeSettings, `Compile resolver ${resolver} failed: ${message}`);
        }
    }

    if (!compiled) {
        throw new Error(`Compilation failed (${runtimeSettings.buildStrategy}): ${failures.join(' | ')}`);
    }

    projectState.needsCompile = false;
}

async function compileProjectWithMaven(projectRoot: string): Promise<void> {
    await execMaven(projectRoot, ['test-compile', '-q']);
}

async function compileProjectWithJavaExtension(documentUri: vscode.Uri): Promise<void> {
    const uri = documentUri.toString();
    const failures: string[] = [];

    try {
        await vscode.commands.executeCommand('java.project.build', documentUri);
        return;
    } catch (err: unknown) {
        failures.push(`java.project.build(documentUri): ${toErrorMessage(err)}`);
    }

    try {
        await vscode.commands.executeCommand('java.project.build', uri);
        return;
    } catch (err: unknown) {
        failures.push(`java.project.build(uri): ${toErrorMessage(err)}`);
    }

    try {
        await vscode.commands.executeCommand('java.workspace.compile');
        return;
    } catch (err: unknown) {
        failures.push(`java.workspace.compile: ${toErrorMessage(err)}`);
    }

    throw new Error(failures.join(' | '));
}

function toErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function getRuntimeSettings(): RuntimeSettings {
    const config = vscode.workspace.getConfiguration('j2html-preview');
    return {
        buildStrategy: normalizeBuildStrategy(config.get<string>('buildStrategy')),
        debugLogs: config.get<boolean>('debugLogs') ?? false,
    };
}

function debugLog(settings: RuntimeSettings, message: string): void {
    if (!settings.debugLogs) {
        return;
    }

    console.log(`[j2html-preview] ${message}`);
}

async function showDiagnostics(): Promise<void> {
    const settings = getRuntimeSettings();
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const previewItems = [...activePreviews.values()]
        .map((preview) => {
            const relativePath = vscode.workspace.asRelativePath(preview.document.uri, false);
            return `- ${preview.className}#${preview.methodName} (${relativePath})`;
        })
        .join('\n');

    const projectItems = [...projectStates.entries()]
        .map(([projectRoot, state]) => {
            const relativeRoot = vscode.workspace.asRelativePath(projectRoot, false);
            const classpathStatus = state.cachedClasspath
                ? `cached (${state.cachedClasspath.split(path.delimiter).filter(Boolean).length} entries)`
                : 'not cached';
            return [
                `- ${relativeRoot || projectRoot}`,
                `  - needsCompile: ${state.needsCompile}`,
                `  - needsClasspathRefresh: ${state.needsClasspathRefresh}`,
                `  - classpath: ${classpathStatus}`,
            ].join('\n');
        })
        .join('\n');

    const markdown = [
        '# j2html Preview Diagnostics',
        '',
        '## Settings',
        `- buildStrategy: ${settings.buildStrategy}`,
        `- debugLogs: ${settings.debugLogs}`,
        '',
        '## Workspace',
        `- folders: ${workspaceFolders.length}`,
        '',
        '## Active Previews',
        previewItems || '- none',
        '',
        '## Project Cache State',
        projectItems || '- none',
    ].join('\n');

    const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: markdown,
    });

    await vscode.window.showTextDocument(document, { preview: true });
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
            const argFileContent = `-cp\n${classpath}\ndev.rebelcraft.j2html.preview.PreviewRunner\n${className}\n${methodName}`;
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
