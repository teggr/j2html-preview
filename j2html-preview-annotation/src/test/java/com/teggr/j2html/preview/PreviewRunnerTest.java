package com.teggr.j2html.preview;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class PreviewRunnerTest {

    // ---------------------------------------------------------------------------
    // Fixtures – must be public so PreviewRunner can instantiate them via reflection
    // ---------------------------------------------------------------------------

    /** A method that returns a plain HTML string. */
    public static class StringPreview {
        @Preview("Hello World")
        public String hello() {
            return "<h1>Hello, World!</h1>";
        }
    }

    /** Mimics a j2html DomContent object that exposes a {@code render()} method. */
    public static class FakeDomContent {
        public String render() {
            return "<p>rendered</p>";
        }
    }

    public static class DomContentPreview {
        @Preview
        public FakeDomContent page() {
            return new FakeDomContent();
        }
    }

    /** A method that returns {@code null}. */
    public static class NullPreview {
        @Preview
        public String empty() {
            return null;
        }
    }

    /** A method that is NOT annotated with {@code @Preview}. */
    public static class NoAnnotation {
        public String hello() {
            return "<h1>Hello</h1>";
        }
    }

    // ---------------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------------

    @Test
    void runsStringReturningMethod() throws Exception {
        String output = PreviewRunner.run(new String[]{
                StringPreview.class.getName(), "hello"
        });
        assertEquals("<h1>Hello, World!</h1>", output);
    }

    @Test
    void runsDomContentReturningMethod() throws Exception {
        String output = PreviewRunner.run(new String[]{
                DomContentPreview.class.getName(), "page"
        });
        assertEquals("<p>rendered</p>", output);
    }

    @Test
    void returnsEmptyStringForNullResult() throws Exception {
        String output = PreviewRunner.run(new String[]{
                NullPreview.class.getName(), "empty"
        });
        assertEquals("", output);
    }

    @Test
    void throwsWhenAnnotationMissing() {
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () ->
                PreviewRunner.run(new String[]{
                        NoAnnotation.class.getName(), "hello"
                }));
        assertTrue(ex.getMessage().contains("@Preview"));
    }

    @Test
    void throwsWhenTooFewArguments() {
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () ->
                PreviewRunner.run(new String[]{}));
        assertTrue(ex.getMessage().contains("Usage"));
    }
}
