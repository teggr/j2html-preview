export function buildJavaClasspathScope(scope: 'runtime' | 'test' = 'test'): string {
    return JSON.stringify({ scope });
}

export function buildJavaGetClasspathsWorkspaceArgs(uri: string): [string, string, string] {
    return [
        'java.project.getClasspaths',
        uri,
        buildJavaClasspathScope('test'),
    ];
}
