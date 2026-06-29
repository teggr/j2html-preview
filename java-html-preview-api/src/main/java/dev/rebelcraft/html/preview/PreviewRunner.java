package dev.rebelcraft.html.preview;

import java.lang.reflect.Method;
import java.lang.reflect.Constructor;

import dev.rebelcraft.html.preview.spi.PreviewGenerators;

/**
 * Command-line utility invoked by the VS Code extension to execute a method
 * annotated with {@link Preview} and print its HTML output to {@code stdout}.
 *
 * <p>Usage:
 * <pre>
 *   java -cp &lt;classpath&gt; dev.rebelcraft.html.preview.PreviewRunner &lt;className&gt; &lt;methodName&gt;
 * </pre>
 *
 * <p>The method metadata is delegated to a discovered preview generator
 * implementation that applies framework-specific invocation and rendering
 * rules. Rendered HTML is written to {@code stdout} so the extension can
 * display it in a WebView panel.
 */
public class PreviewRunner {

    public static void main(String[] args) {
        try {
            String html = run(args);
            System.out.println(html);
        } catch (IllegalArgumentException e) {
            System.err.println(e.getMessage());
            System.exit(1);
        } catch (Exception e) {
            System.err.println("Error: " + e.getMessage());
            System.exit(1);
        }
    }

    /**
     * Resolves, validates, and invokes the annotated method, returning its
     * rendered HTML output. Throws {@link IllegalArgumentException} for usage
     * errors so that callers (including tests) can handle them without
     * triggering {@link System#exit}.
     */
    static String run(String[] args) throws Exception {
        if (args.length < 2) {
            throw new IllegalArgumentException(
                    "Usage: PreviewRunner <className> <methodName>");
        }

        String className = args[0];
        String methodName = normalizeMethodName(args[1]);

        Class<?> clazz = Class.forName(className);
        Method method;
        try {
            method = clazz.getDeclaredMethod(methodName);
        } catch (NoSuchMethodException e) {
            throw new IllegalArgumentException(
                    "Could not find preview method '" + methodName + "' on class '"
                            + className + "'. Preview methods may be public, protected, package-private, or private, but they must be no-argument instance methods annotated with @Preview.",
                    e);
        }
        method.setAccessible(true);

        if (!method.isAnnotationPresent(Preview.class)) {
            throw new IllegalArgumentException(
                    "Method '" + methodName + "' on class '" + className
                            + "' is not annotated with @Preview");
        }

        Preview preview = method.getAnnotation(Preview.class);
        return PreviewGenerators.generate(clazz, method, preview);
    }

    private static String normalizeMethodName(String methodName) {
        int parenIndex = methodName.indexOf('(');
        if (parenIndex < 0) {
            return methodName;
        }

        return methodName.substring(0, parenIndex).trim();
    }

    public static <T> T newAccessibleInstance(Class<T> clazz) throws Exception {
        Constructor<T> constructor = clazz.getDeclaredConstructor();
        constructor.setAccessible(true);
        return constructor.newInstance();
    }
}