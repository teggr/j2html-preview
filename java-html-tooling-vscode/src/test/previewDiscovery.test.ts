import test from 'node:test';
import assert from 'node:assert/strict';

import {
    discoverPreviewTargets,
    discoverPreviewTargetsWithRegexFallback,
    type PreviewSymbolNode,
} from '../previewDiscovery';

test('discovers preview targets from Java symbols and source annotations', () => {
    const documentText = `package com.example.preview;

public class PreviewExamples {

    @Preview
    public String alpha() {
        return "<h1>alpha</h1>";
    }

    @Preview("secondary")
    public String beta() {
        return "<h1>beta</h1>";
    }

    public String ignored(String input) {
        return input;
    }
}`;

    const symbols: PreviewSymbolNode[] = [
        {
            kind: 'class',
            name: 'PreviewExamples',
            startLine: 2,
            selectionStartLine: 2,
            children: [
                {
                    kind: 'method',
                    name: 'alpha()',
                    startLine: 4,
                    selectionStartLine: 4,
                    children: [],
                },
                {
                    kind: 'method',
                    name: 'beta()',
                    startLine: 9,
                    selectionStartLine: 9,
                    children: [],
                },
                {
                    kind: 'method',
                    name: 'ignored(String)',
                    startLine: 13,
                    selectionStartLine: 13,
                    children: [],
                },
            ],
        },
    ];

    assert.deepEqual(discoverPreviewTargets(documentText, symbols), [
        {
            annotationLine: 4,
            className: 'com.example.preview.PreviewExamples',
            methodName: 'alpha',
        },
        {
            annotationLine: 9,
            className: 'com.example.preview.PreviewExamples',
            methodName: 'beta',
            previewLabel: 'secondary',
        },
    ]);
});

test('supports nested classes when resolving preview targets', () => {
    const documentText = `package com.example.preview;

public class OuterPreview {

    class InnerPreview {
        @Preview
        public String nested() {
            return "nested";
        }
    }
}`;

    const symbols: PreviewSymbolNode[] = [
        {
            kind: 'class',
            name: 'OuterPreview',
            startLine: 2,
            selectionStartLine: 2,
            children: [
                {
                    kind: 'class',
                    name: 'InnerPreview',
                    startLine: 4,
                    selectionStartLine: 4,
                    children: [
                        {
                            kind: 'method',
                            name: 'nested()',
                            startLine: 6,
                            selectionStartLine: 6,
                            children: [],
                        },
                    ],
                },
            ],
        },
    ];

    assert.deepEqual(discoverPreviewTargets(documentText, symbols), [
        {
            annotationLine: 5,
            className: 'com.example.preview.OuterPreview.InnerPreview',
            methodName: 'nested',
        },
    ]);
});

test('falls back to regex discovery when symbols are unavailable', () => {
    const documentText = `package org.example;

public class ExampleTestClassTest {

    @Preview("my test")
    public DomContent aSample() {
        return J2HtmlComponents.bootstrapForm();
    }

    @Preview("output")
    public DomContent kate() {
        return TagCreator.textarea("something inspiring");
    }
}`;

    assert.deepEqual(discoverPreviewTargetsWithRegexFallback(documentText), [
        {
            annotationLine: 4,
            className: 'org.example.ExampleTestClassTest',
            methodName: 'aSample',
            previewLabel: 'my test',
        },
        {
            annotationLine: 9,
            className: 'org.example.ExampleTestClassTest',
            methodName: 'kate',
            previewLabel: 'output',
        },
    ]);
});

test('regex fallback supports non-public classes with modifiers', () => {
    const documentText = `package org.example;

final class PackagePrivatePreview {

    @Preview("pkg-private")
    protected String sample() {
        return "<p>ok</p>";
    }
}`;

    assert.deepEqual(discoverPreviewTargetsWithRegexFallback(documentText), [
        {
            annotationLine: 4,
            className: 'org.example.PackagePrivatePreview',
            methodName: 'sample',
            previewLabel: 'pkg-private',
        },
    ]);
});