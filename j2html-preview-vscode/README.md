# j2html Preview – VS Code Extension

Adds an Xcode-style `▶ Preview` CodeLens above every `@Preview`-annotated method in Java files, and renders the returned HTML in a side-panel WebView.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [VS Code](https://code.visualstudio.com/) 1.85+
- [Java](https://adoptium.net/) 17+
- [Language Support for Java by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.java)
- [Maven](https://maven.apache.org/) 3.8+ (`mvn` on your `PATH`)

The extension declares `redhat.java` as a dependency and bundles Maven for Java / Project Manager for Java in its extension pack metadata so the expected Java workspace tooling is installed alongside it.

## Settings

- `j2html-preview.cssFiles`: CSS files/globs/URLs to inject into preview output.
- `j2html-preview.inlineStyles`: Inline CSS appended to preview output.
- `j2html-preview.buildStrategy`: `java-first` (default) or `maven-first`.
    - `java-first` tries Java extension APIs first and falls back to Maven commands.
    - `maven-first` tries Maven commands first and falls back to Java extension APIs.
- `j2html-preview.debugLogs`: when `true`, logs classpath/build decision paths and fallback reasons.

## Commands

- `j2html: Open Preview` — open or refresh preview for the selected `@Preview` method.
- `j2html: Show Diagnostics` — opens a markdown report with current settings, active previews, and per-project cache state.

## Running the extension in development mode

Development mode lets you test the extension on any project without packaging or publishing it.

### 1. Build the annotation JAR

The extension calls `PreviewRunner` at runtime, so the annotation module must be installed into your local Maven repository first.

```bash
cd j2html-preview
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

Inside the Extension Development Host window, open a Maven project that depends on `j2html-preview`:

```xml
<!-- in your project's pom.xml -->
<dependency>
    <groupId>dev.rebelcraft</groupId>
    <artifactId>j2html-preview</artifactId>
    <version>1.0.0-SNAPSHOT</version>
</dependency>
```

Then annotate a no-arg method with `@Preview`:

```java
import dev.rebelcraft.j2html.preview.Preview;

public class MyPreviews {

    @Preview("Main layout")
    public String mainLayout() {
        return "<h1>Hello, j2html!</h1>";
    }
}
```

Open the Java file in the editor — a **▶ Preview** CodeLens appears above the method. Click it to compile the project and render the HTML output in a panel beside the editor.

Once a preview is open:

- saving the preview source file reruns the preview after a short debounce
- saving configured CSS files rerenders the existing HTML without rerunning Maven or Java
- changing `pom.xml` invalidates the cached classpath so the next preview refresh resolves dependencies again

### 5. Iterating quickly

Run the TypeScript compiler in watch mode so recompilation happens on every save:

```bash
npm run watch
```

After saving a change to `src/extension.ts`, reload the Extension Development Host window (**Ctrl+R** / **Cmd+R**) to pick up the new build.

## How it works

1. **CodeLens** — `PreviewCodeLensProvider` asks VS Code's Java symbol provider for classes and methods, then matches `@Preview` annotations from source text onto those symbols before registering a `▶ Preview` lens for each match.
2. **Build** — clicking the lens compiles using the configured strategy (`j2html-preview.buildStrategy`): Java extension first or Maven first, with fallback to the other path when needed. The compile step is cached until a Java or `pom.xml` change invalidates it.
3. **Classpath** — classpath resolution also follows `j2html-preview.buildStrategy`, with fallback between Java extension classpath and Maven dependency classpath. The resolved classpath is cached and recomputed when `pom.xml` changes.
4. **Run** — `java -cp <classpath> dev.rebelcraft.j2html.preview.PreviewRunner <className> <methodName>` is executed and its stdout (the rendered HTML) is displayed in the WebView panel.
5. **Refresh** — when CSS changes, the extension reuses the last rendered HTML and only reinjects styles into the WebView instead of rerunning the preview method.

## Release and installation

- **VS Code Marketplace**: install from the Marketplace listing for automatic update delivery.
- **Direct VSIX**: download the `.vsix` attached to each GitHub Release and install via **Extensions: Install from VSIX...**.

Repository workflows support both channels: GitHub Release artifacts are always produced, and Marketplace publishing is opt-in per manual release run.
