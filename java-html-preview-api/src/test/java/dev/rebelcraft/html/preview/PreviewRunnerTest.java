package dev.rebelcraft.html.preview;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class PreviewRunnerTest {

    // ---------------------------------------------------------------------------
    // Fixtures - must be public so PreviewRunner can instantiate them via reflection
    // ---------------------------------------------------------------------------

    /** A method that returns a plain HTML string. */
    public static class StringPreview {
        @Preview("Hello World")
        public String hello() {
            return "<h1>Hello, World!</h1>";
        }
    }

    /** Mimics a non-String preview payload object. */
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

    public static class PlainObjectPreview {
        @Preview
        public Object plain() {
            return new Object() {
                @Override
                public String toString() {
                    return "plain-object";
                }
            };
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

    static class HiddenPreview {
        @Preview
        private String hidden() {
            return "<p>hidden</p>";
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
    void normalizesParenthesizedMethodNames() throws Exception {
        String output = PreviewRunner.run(new String[]{
                StringPreview.class.getName(), "hello()"
        });
        assertEquals("<h1>Hello, World!</h1>", output);
    }

    @Test
    void runsPrivateMethodOnPackagePrivateClass() throws Exception {
        String output = PreviewRunner.run(new String[]{
                HiddenPreview.class.getName(), "hidden"
        });
        assertEquals("<p>hidden</p>", output);
    }

    @Test
    void runsDomContentReturningMethod() throws Exception {
        String output = PreviewRunner.run(new String[]{
                DomContentPreview.class.getName(), "page"
        });
        assertEquals("high-priority-generator", output);
    }

    @Test
    void throwsWhenNoGeneratorSupportsMethod() {
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
            PreviewRunner.run(new String[]{
                PlainObjectPreview.class.getName(), "plain"
            }));
        assertTrue(ex.getMessage().contains("No preview generator supports method"));
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