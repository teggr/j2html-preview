package com.teggr.j2html.preview;

import java.lang.reflect.Method;

/**
 * Command-line utility invoked by the VS Code extension to execute a method
 * annotated with {@link Preview} and print its HTML output to {@code stdout}.
 *
 * <p>Usage:
 * <pre>
 *   java -cp &lt;classpath&gt; com.teggr.j2html.preview.PreviewRunner &lt;className&gt; &lt;methodName&gt;
 * </pre>
 *
 * <p>The method must be public, take no arguments, and return either a plain
 * {@link String} or a j2html {@code DomContent} object that exposes a
 * {@code render()} method.  The rendered HTML is written to {@code stdout} so
 * that the extension can capture it and display it in a WebView panel.
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
     * rendered HTML output.  Throws {@link IllegalArgumentException} for usage
     * errors so that callers (including tests) can handle them without
     * triggering {@link System#exit}.
     */
    static String run(String[] args) throws Exception {
        if (args.length < 2) {
            throw new IllegalArgumentException(
                    "Usage: PreviewRunner <className> <methodName>");
        }

        String className = args[0];
        String methodName = args[1];

        Class<?> clazz = Class.forName(className);
        Method method = clazz.getMethod(methodName);

        if (!method.isAnnotationPresent(Preview.class)) {
            throw new IllegalArgumentException(
                    "Method '" + methodName + "' on class '" + className
                            + "' is not annotated with @Preview");
        }

        Object instance = clazz.getDeclaredConstructor().newInstance();
        Object result = method.invoke(instance);

        if (result == null) {
            return "";
        }

        // Support j2html DomContent objects (which have a render() method) as
        // well as plain String returns.
        try {
            Method renderMethod = result.getClass().getMethod("render");
            return (String) renderMethod.invoke(result);
        } catch (NoSuchMethodException e) {
            return result.toString();
        }
    }
}
