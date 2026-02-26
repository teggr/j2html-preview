package com.teggr.j2html.preview;

import java.util.HashMap;
import java.util.Map;

import j2html.TagCreator;
import j2html.tags.DomContent;

/**
 * Example class demonstrating the @Preview annotation.
 * Each @Preview method can be executed from VS Code to see the HTML output.
 */
public class HelloWorldExample {

    @Preview("Hello World")
    public String hello() {
        return "<h1>Hello, World today!</h1>";
    }

    @Preview("Welcome Message")
    public String welcome() {
        return """
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Welcome</title>
                    <style>
                        body { font-family: Arial, sans-serif; padding: 20px; }
                        h1 { color: #007acc; }
                    </style>
                </head>
                <body>
                    <h1>Welcome to j2html Preview!</h1>
                    <p>This is a preview of your HTML content.</p>
                </body>
                </html>
                """;
    }

    @Preview("Simple Card")
    public String card() {
        return """
                <div style="border: 1px solid #ddd; border-radius: 8px; padding: 20px; max-width: 300px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <h2 style="margin-top: 0; color: #333;">Card Title</h2>
                    <p style="color: #666;">This is a simple card component with some example content.</p>
                    <button style="background: #007acc; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer;">
                        Click Me
                    </button>
                </div>
                """;
    }

    @Preview("A dom content")
    public DomContent h1WithParagraph() {

        Map<String, String> values = new HashMap<>();

        return render(values);
    }

    public static DomContent render(Map<String, String> values) {
        return TagCreator.div(
            TagCreator.h1("Today, Tomorrow"),
            TagCreator.p("This is the next genration"),
            TagCreator.input().withValue("does this work")
        );
    }
    
}
