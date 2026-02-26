# j2html Preview – VS Code Extension

Adds an Xcode-style `▶ Preview` CodeLens above every `@Preview`-annotated method in Java files, and renders the returned HTML in a side-panel WebView.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [VS Code](https://code.visualstudio.com/) 1.85+
- [Java](https://adoptium.net/) 17+
- [Maven](https://maven.apache.org/) 3.8+ (`mvn` on your `PATH`)

## Running the extension in development mode

Development mode lets you test the extension on any project without packaging or publishing it.

### 1. Build the annotation JAR

The extension calls `PreviewRunner` at runtime, so the annotation module must be installed into your local Maven repository first.

```bash
cd j2html-preview-annotation
mvn install -q
```

### 2. Install extension dependencies and compile

```bash
cd j2html-preview-vscode
npm install
npm run compile
```

### 3. Launch the Extension Development Host

Press **F5** (or go to **Run → Start Debugging**) from any workspace folder.

VS Code opens a second window labelled **[Extension Development Host]** with the extension loaded from your local source. Any change you make followed by `npm run compile` (or `npm run watch` for automatic recompilation) is reflected immediately after reloading the host window (**Ctrl+R** / **Cmd+R**).

> **Note:** You can work from either the root `j2html-preview` folder or open just the `j2html-preview-vscode` subfolder—both work. The root folder includes a `.vscode/launch.json` configuration that automatically targets the extension subfolder.

### 4. Test on an example project

Inside the Extension Development Host window, open a Maven project that depends on `j2html-preview-annotation`:

```xml
<!-- in your project's pom.xml -->
<dependency>
    <groupId>com.teggr.j2html</groupId>
    <artifactId>j2html-preview-annotation</artifactId>
    <version>1.0.0-SNAPSHOT</version>
</dependency>
```

Then annotate a no-arg method with `@Preview`:

```java
import com.teggr.j2html.preview.Preview;

public class MyPreviews {

    @Preview("Main layout")
    public String mainLayout() {
        return "<h1>Hello, j2html!</h1>";
    }
}
```

Open the Java file in the editor — a **▶ Preview** CodeLens appears above the method. Click it to compile the project and render the HTML output in a panel beside the editor.

### 5. Iterating quickly

Run the TypeScript compiler in watch mode so recompilation happens on every save:

```bash
npm run watch
```

After saving a change to `src/extension.ts`, reload the Extension Development Host window (**Ctrl+R** / **Cmd+R**) to pick up the new build.

## How it works

1. **CodeLens** — `PreviewCodeLensProvider` scans the open Java file for `@Preview` annotations and registers a `▶ Preview` lens above each matching method.
2. **Build** — clicking the lens runs `mvn test-compile -q` in the nearest Maven project root (located by walking up from the current file until a `pom.xml` is found).
3. **Classpath** — `mvn dependency:build-classpath` resolves all compile + test dependencies into a single classpath string.
4. **Run** — `java -cp <classpath> com.teggr.j2html.preview.PreviewRunner <className> <methodName>` is executed and its stdout (the rendered HTML) is displayed in the WebView panel.
