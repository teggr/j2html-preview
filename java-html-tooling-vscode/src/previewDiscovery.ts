export interface PreviewSymbolNode {
    kind: 'class' | 'interface' | 'method';
    name: string;
    startLine: number;
    selectionStartLine: number;
    children: PreviewSymbolNode[];
}

export interface PreviewTarget {
    annotationLine: number;
    className: string;
    methodName: string;
    previewLabel?: string;
}

const MAX_ANNOTATION_DISTANCE = 12;

interface MethodCandidate {
    className: string;
    methodName: string;
    selectionStartLine: number;
}

interface PreviewAnnotation {
    line: number;
    label?: string;
}

export function discoverPreviewTargets(
    documentText: string,
    symbols: PreviewSymbolNode[],
): PreviewTarget[] {
    const lines = documentText.split(/\r?\n/);
    const packageName = extractPackageName(documentText);
    const methodCandidates = collectMethodCandidates(lines, symbols, packageName);
    const annotations = collectPreviewAnnotations(lines);
    const targets: PreviewTarget[] = [];
    const seen = new Set<string>();

    for (const annotation of annotations) {
        const methodCandidate = methodCandidates.find(
            (candidate) =>
                candidate.selectionStartLine >= annotation.line
                && candidate.selectionStartLine - annotation.line <= MAX_ANNOTATION_DISTANCE,
        );

        if (!methodCandidate) {
            continue;
        }

        const key = `${methodCandidate.className}#${methodCandidate.methodName}#${methodCandidate.selectionStartLine}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        const previewLabel = annotation.label;
        targets.push({
            annotationLine: annotation.line,
            className: methodCandidate.className,
            methodName: methodCandidate.methodName,
            ...(previewLabel ? { previewLabel } : {}),
        });
    }

    return targets;
}

function collectPreviewAnnotations(lines: string[]): PreviewAnnotation[] {
    const annotations: PreviewAnnotation[] = [];

    for (let index = 0; index < lines.length; index++) {
        const trimmedLine = lines[index].trim();
        if (trimmedLine === '@Preview' || trimmedLine.startsWith('@Preview(')) {
            annotations.push({
                line: index,
                label: extractPreviewLabel(trimmedLine),
            });
        }
    }

    return annotations;
}

function extractPreviewLabel(trimmedAnnotationLine: string): string | undefined {
    const match = trimmedAnnotationLine.match(/^@Preview\(\s*"((?:\\.|[^"\\])*)"\s*\)/);
    if (!match) {
        return undefined;
    }

    return match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function extractPackageName(documentText: string): string | undefined {
    const packageMatch = documentText.match(/^package\s+([\w.]+)\s*;/m);
    return packageMatch?.[1];
}

function collectMethodCandidates(
    lines: string[],
    symbols: PreviewSymbolNode[],
    packageName?: string,
): MethodCandidate[] {
    const methods: MethodCandidate[] = [];

    const visit = (nodes: PreviewSymbolNode[], classStack: string[]) => {
        for (const node of nodes) {
            if (node.kind === 'class' || node.kind === 'interface') {
                visit(node.children, [...classStack, node.name]);
                continue;
            }

            if (node.kind !== 'method' || classStack.length === 0) {
                continue;
            }

            const methodName = extractMethodName(node.name);
            if (!methodName || !isNoArgMethod(lines, node.selectionStartLine, methodName)) {
                continue;
            }

            const className = packageName
                ? `${packageName}.${classStack.join('.')}`
                : classStack.join('.');

            methods.push({
                className,
                methodName,
                selectionStartLine: node.selectionStartLine,
            });
        }
    };

    visit(symbols, []);
    methods.sort((left, right) => left.selectionStartLine - right.selectionStartLine);
    return methods;
}

function extractMethodName(symbolName: string): string | undefined {
    const methodMatch = symbolName.match(/^([\w$]+)\s*\(/);
    if (methodMatch) {
        return methodMatch[1];
    }

    return /^[\w$]+$/.test(symbolName) ? symbolName : undefined;
}

function isNoArgMethod(lines: string[], selectionStartLine: number, methodName: string): boolean {
    const searchStart = Math.max(0, selectionStartLine - 1);
    const searchEnd = Math.min(lines.length, selectionStartLine + 3);
    const signatureText = lines.slice(searchStart, searchEnd).join(' ');
    const escapedMethodName = escapeRegExp(methodName);
    const noArgPattern = new RegExp(`${escapedMethodName}\\s*\\(\\s*\\)`);
    return noArgPattern.test(signatureText);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

export function discoverPreviewTargetsWithRegexFallback(documentText: string): PreviewTarget[] {
    const lines = documentText.split(/\r?\n/);
    const packageMatch = documentText.match(/^package\s+([\w.]+)\s*;/m);
    const classMatch = documentText.match(
        /^\s*(?:(?:public|protected|private|abstract|final|sealed|non-sealed|static)\s+)*(?:class|interface)\s+(\w+)/m,
    );
    if (!classMatch) {
        return [];
    }

    const simpleName = classMatch[1];
    const className = packageMatch ? `${packageMatch[1]}.${simpleName}` : simpleName;
    const targets: PreviewTarget[] = [];

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed !== '@Preview' && !trimmed.startsWith('@Preview(')) {
            continue;
        }

        for (let j = i + 1; j < Math.min(i + MAX_ANNOTATION_DISTANCE, lines.length); j++) {
            const methodMatch = lines[j].match(
                /(?:public|protected|private)\s+(?:(?:static|final|synchronized)\s+)*[\w<>[\],\s]+\s+(\w+)\s*\(\s*\)\s*(?:throws\s+[\w,\s]+)?\s*\{?/,
            );
            if (!methodMatch) {
                continue;
            }

            const previewLabel = extractPreviewLabel(trimmed);
            targets.push({
                annotationLine: i,
                className,
                methodName: methodMatch[1],
                ...(previewLabel ? { previewLabel } : {}),
            });
            break;
        }
    }

    return targets;
}