# Release to Maven Central (Local)

This document follows the same local release pattern used in j2html-extensions.

Artifact:
- dev.rebelcraft:j2html-preview

## Prerequisites

- Java 17+
- Maven 3.8+
- GPG key configured locally
- Sonatype Central credentials in ~/.m2/settings.xml

Expected Maven server entries:
- central (username/token for Sonatype Central)
- <gpg.keyname> (passphrase for your GPG key)

## Release steps

```bash
# 1) Start from a clean working tree
cd j2html-preview
git status
mvn clean

# 2) Tag the release in git
git tag <version>

# 3) Set release version (remove -SNAPSHOT)
mvn -Pcentral versions:set -DremoveSnapshot

# 4) Validate POM metadata for Maven Central
mvn -Pcentral org.kordamp.maven:pomchecker-maven-plugin:1.14.0:check-maven-central

# 5) Deploy signed artifacts to Maven Central
mvn -Pcentral deploy -DignorePublishedComponents=true

# 6) Move to next snapshot
mvn -Pcentral versions:set -DnextSnapshot
mvn -Pcentral versions:commit

# 7) Commit and push version changes + tag
git add pom.xml
git commit -m "release(preview): <version>"
git push --follow-tags
```

## Notes

- If deployment partially succeeds, do not reuse the same release version.
- Bump to the next version and run the flow again.
- Check publication status in the Sonatype Central portal.
