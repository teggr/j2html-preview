package dev.rebelcraft.html.preview.spi;

import java.lang.reflect.Method;
import java.util.Comparator;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.stream.Stream;

import dev.rebelcraft.html.preview.Preview;
import dev.rebelcraft.html.preview.PreviewRunner;

/**
 * Discovers and selects {@link PreviewGenerator} implementations.
 */
public final class PreviewGenerators {

    private PreviewGenerators() {
    }

    /**
     * Generates preview HTML using the highest-priority matching generator.
     */
    public static String generate(Class<?> clazz, Method method, Preview preview) throws Exception {
        Optional<PreviewGenerator> generator = resolve(clazz, method);
        if (generator.isPresent()) {
            return generator.get().generate(clazz, method, preview);
        }

        throw new IllegalStateException(
                "No preview generator supports method '"
                        + clazz.getName()
                        + "#"
                        + method.getName()
                        + "'. Add an implementation module that provides "
                        + PreviewGenerator.class.getName()
                        + "."
        );
    }

    /**
     * Resolves the highest-priority generator that supports this method.
     */
    public static Optional<PreviewGenerator> resolve(Class<?> clazz, Method method) {
        Stream<PreviewGenerator> discovered = ServiceLoader.load(PreviewGenerator.class)
                .stream()
                .map(ServiceLoader.Provider::get);

        Stream<PreviewGenerator> defaults = Stream.of(new StringReturnPreviewGenerator());

        return Stream.concat(discovered, defaults)
                .filter(generator -> generator.supports(clazz, method))
                .max(Comparator.comparingInt(PreviewGenerator::priority));
    }

    /**
     * Built-in strategy for String-returning preview methods.
     */
    private static final class StringReturnPreviewGenerator implements PreviewGenerator {

        @Override
        public String id() {
            return "string-return-default";
        }

        @Override
        public int priority() {
            return 0;
        }

        @Override
        public boolean supports(Class<?> clazz, Method method) {
            return method.getParameterCount() == 0 && method.getReturnType() == String.class;
        }

        @Override
        public String generate(Class<?> clazz, Method method, Preview preview) throws Exception {
            Object instance = PreviewRunner.newAccessibleInstance(clazz);
            Object result = method.invoke(instance);
            return result == null ? "" : (String) result;
        }
    }
}
