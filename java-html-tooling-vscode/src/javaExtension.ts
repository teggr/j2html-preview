import * as path from 'path';
import * as vscode from 'vscode';
import { buildJavaGetClasspathsWorkspaceArgs } from './javaClasspathCommand';

interface JavaProjectClasspathResult {
    classpaths?: unknown;
    modulepaths?: unknown;
}

interface JavaExtensionApi {
    getClasspaths?: (
        uri: string,
        options: { scope: 'runtime' | 'test' },
    ) => Promise<JavaProjectClasspathResult | undefined>;
}

function toStringArray(value: unknown): string[] {
    if (!value) {
        return [];
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => (typeof item === 'string' ? item : item?.toString()))
            .filter((item): item is string => Boolean(item));
    }

    const items: string[] = [];

    try {
        for (const item of value as Iterable<unknown>) {
            const stringValue = typeof item === 'string' ? item : item?.toString();
            if (stringValue) {
                items.push(stringValue);
            }
        }
    } catch {
        // Ignore non-iterables from the extension host bridge.
    }

    return items;
}

async function ensureJavaExtension(): Promise<void> {
    const extension = vscode.extensions.getExtension('redhat.java');
    if (!extension) {
        throw new Error(
            'Red Hat\'s Language Support for Java extension is required for classpath resolution.',
        );
    }

    if (!extension.isActive) {
        await extension.activate();
    }
}

export async function resolveJavaExtensionClasspath(
    documentUri: vscode.Uri,
    projectRoot: string,
): Promise<string[]> {
    await ensureJavaExtension();

    const result = await requestJavaProjectClasspaths(documentUri);

    if (!result) {
        throw new Error('Java extension did not return classpath information.');
    }

    const entries = [
        ...toStringArray(result.classpaths),
        ...toStringArray(result.modulepaths),
        path.join(projectRoot, 'target', 'classes'),
        path.join(projectRoot, 'target', 'test-classes'),
    ];

    return [...new Set(entries.filter(Boolean))];
}

async function requestJavaProjectClasspaths(
    documentUri: vscode.Uri,
): Promise<JavaProjectClasspathResult> {
    const uri = documentUri.toString();
    const extension = vscode.extensions.getExtension('redhat.java');
    const api = extension?.exports as JavaExtensionApi | undefined;

    try {
        if (typeof api?.getClasspaths === 'function') {
            const result = await api.getClasspaths(uri, { scope: 'test' });

            if (result) {
                return result;
            }
        }
    } catch {
        // Fall through to workspace command API.
    }

    try {
        const [command, javaUri, scope] = buildJavaGetClasspathsWorkspaceArgs(uri);
        const result = await vscode.commands.executeCommand<JavaProjectClasspathResult>(
            'java.execute.workspaceCommand',
            command,
            javaUri,
            scope,
        );

        if (result) {
            return result;
        }
    } catch {
        // Fall through to object-options command shape for older Java extension versions.
    }

    const fallbackResult = await vscode.commands.executeCommand<JavaProjectClasspathResult>(
        'java.execute.workspaceCommand',
        'java.project.getClasspaths',
        uri,
        { scope: 'test' },
    );

    if (!fallbackResult) {
        throw new Error('Java extension did not return classpath information.');
    }

    return fallbackResult;
}