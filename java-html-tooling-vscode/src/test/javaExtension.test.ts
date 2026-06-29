import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildJavaClasspathScope,
    buildJavaGetClasspathsWorkspaceArgs,
} from '../javaClasspathCommand';

test('builds classpath scope payload as JSON string for Java workspace command', () => {
    const payload = buildJavaClasspathScope('test');
    assert.equal(payload, '{"scope":"test"}');
    assert.deepEqual(JSON.parse(payload), { scope: 'test' });
});

test('builds java.project.getClasspaths args in expected order', () => {
    const uri = 'file:///c%3A/tmp/MyClass.java';
    assert.deepEqual(buildJavaGetClasspathsWorkspaceArgs(uri), [
        'java.project.getClasspaths',
        uri,
        '{"scope":"test"}',
    ]);
});
