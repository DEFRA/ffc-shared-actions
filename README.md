# ffc-shared-actions

A collection of shared actions for use in GitHub workflows across the FFC repositories.
Structure for GitHub actions is for actions to reside in the .github/workflows directory of the repository.

## Usage
To use an action from this repository in your workflow, you can reference it in the consuming service


# Workflows

## Secret Scanning

This repository includes a shared `gitleaks.toml` configuration used by the `secret-scanner.yml`
workflow and, optionally, a local pre-commit hook. Both environments use the same file so scanning
behaviour is consistent across CI and local development.

### How it works

The configuration extends the default gitleaks ruleset, inheriting detection of common credentials
(AWS keys, GitHub tokens, high-entropy strings, private keys, etc.) and adds FFC-specific rules on top as custom rules.

### Custom rules

| Rule | What it detects | Scope |
|---|---|---|
| `azure-client-secret` | Azure client secrets as literal values | All files |
| `db-connection-string` | Database URIs with embedded passwords | All files |
| `notify-api-key` | GOV.UK Notify API keys | All files |
| `plaintext-email-address` | Plain text email addresses (PII) | All files (package metadata and placeholder domains suppressed) |
| `appconfig-literal-secret` | Literal secrets that should be KeyVault references | `appconfig/*.yaml` only |

### Service-level customisation

A consuming service can place its own `gitleaks.toml` in the repository root. It should extend
this shared configuration and add only service-specific rules or allowlist entries. See the
[gitleaks documentation](https://github.com/zricethezav/gitleaks/blob/master/config/gitleaks.toml)
for configuration reference.

### Adding allowlist entries

- Prefer path-based allowlisting over regex where possible.
- Add rule-level suppressions inside `[rules.allowlist]` within the relevant `[[rules]]` block,
  not in the global `[allowlist]`, to avoid unintentionally suppressing other rules.
- Always include a comment explaining why the entry is safe.

# Local Sonar Check

`scripts/sonar-check.js` shows a dev the real SonarCloud Quality Gate result for their branch before
they push. It runs the service's tests, submits an analysis in branch mode and prints a summary:

```
Quality Gate Passed

Issues
  0 New issues
  0 Accepted issues

Measures
  0 Security Hotspots
  100.0% Coverage on New Code
  0.0% Duplication on New Code

See analysis details on SonarQube Cloud: https://sonarcloud.io/dashboard?id=<service>&branch=<branch>
```

It always runs in branch mode, so nothing is posted to the pull request. The project key comes from
`package.json` and the branch from git, so there's no per service config.

### Skipping the tests when nothing has changed

When the tests pass, the check saves a fingerprint of the code (a git tree hash of the working tree,
including uncommitted and new files) to `test-output/.sonar-check.json`. Next time, if the fingerprint
matches and `lcov.info` hasn't been rewritten since, it skips the tests and reuses the coverage:

```
No code changes since the tests passed 4 minutes ago, reusing their coverage.
```

So running `./scripts/sonar -f` straight after `./scripts/test` goes straight to the Sonar check.
The fingerprint is built in a copy of the git index, so staged changes aren't touched.

### Options

| Option | Description |
|---|---|
| `-t`, `--run-tests` | Always run `scripts/test`, even if nothing has changed |
| `-s`, `--skip-tests` | Never run `scripts/test`, reuse `test-output/lcov.info` as it is (warns if the code has changed) |
| `-f`, `--files` | List files with uncovered new code, worst first |
| `-h`, `--help` | Show help |
| `--after-tests` | Used by the `scripts/test` hook to record a passing run |

Set `NO_COLOR=1` to turn off colour. The script exits 1 if the gate fails.

### Requirements

- Membership of the `defra` SonarCloud organisation
- A personal token from https://sonarcloud.io/account/security exported in your shell, e.g. in `~/.bashrc`:
  `export SONAR_TOKEN=<token>`
- Node 18 or later, Docker and curl

### Adding it to a service

Add `scripts/sonar` to the service. It fetches the shared script and runs it, passing through any options:

```sh
#!/usr/bin/env sh

# Local SonarCloud Quality Gate check, shared across FCP services.
# The logic lives in DEFRA/ffc-shared-actions, run scripts/sonar --help for options.

set -e

checkUrl="${SONAR_CHECK_URL:-https://raw.githubusercontent.com/DEFRA/ffc-shared-actions/main/scripts/sonar-check.js}"
checkScript="$(mktemp)"
trap 'rm -f "${checkScript}"' EXIT

if ! curl -sSfL "${checkUrl}" -o "${checkScript}"; then
  echo "Failed to fetch the shared Sonar check from ${checkUrl}" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
node "${checkScript}" "$@"
```

Add this to the end of `scripts/test` so the check runs after the tests when `SONAR_TOKEN` is set:

```sh
if [ "${SONAR_SKIP_AUTOCHECK}" != "true" ]; then
  if [ -n "${SONAR_TOKEN}" ]; then
    "${projectRoot}/scripts/sonar" --after-tests
  else
    echo "SONAR_TOKEN not set, skipping Sonar Quality Gate check (see scripts/sonar --help)"
  fi
fi
```

And add `"test:sonar": "./scripts/sonar"` to the `scripts` in `package.json`.

To test changes to the shared script before they're merged, point `SONAR_CHECK_URL` at a branch or a
local copy, e.g. `SONAR_CHECK_URL=file:///path/to/sonar-check.js ./scripts/sonar -s`.

# Version Bump Workflow

This workflow provides automated version management for Node.js projects using npm and GPG-signed commits. Not to be confused by the shared-action-versioning also in this repository, which is for managing versions of the shared actions themselves. This workflow is designed to be reusable across multiple service repositories, ensuring consistent version bumping practices while maintaining security through GPG signing.

## Overview

The reusable workflow:
- Automatically compares your current `package.json` version with the latest GitHub release/tag
- Bumps the patch version if needed
- Commits and pushes the change back to the PR branch with GPG signature
- Skips the bump if the current version is already ahead

## How to Use

### 1. Set up GPG Keys in Your Service Repository

Each service needs to store its own GPG signing keys as repository secrets:

- `GPG_PRIVATE_KEY` - Your GPG private key (export with `gpg --armor --export-secret-key YOUR_KEY_ID`)
- `GPG_KEY_ID` - Your GPG key ID
- `GPG_EMAIL` - Email associated with the GPG key
- `GPG_NAME` - Name associated with the GPG key
- `GITHUB_TOKEN` - Automatically provided by GitHub Actions (use `${{ secrets.GITHUB_TOKEN }}`)

### 2. Create a Workflow in Your Service Repository

Create `.github/workflows/version-bump.yml` in your service repository:

```yaml
name: Version Bump

on:
  pull_request:
    branches:
      - main
    types:
      - opened
      - synchronize
      - reopened

jobs:
  version-bump:
    uses: DEFRA/ffc-shared-actions/.github/workflows/version-bump.yml@main
    with:
      node-version: '24'
    secrets: inherit
```

### 3. Adjust the Reference Version

Replace `@main` with a specific version tag once the workflow is released:

```yaml
uses: DEFRA/ffc-shared-actions/.github/workflows/version-bump-reusable.yml@v1.0.0
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `node-version` | Node.js version to use | No | `'24'` |
| `target-branch` | Target branch for version bump | No | `'main'` |

## Secrets

| Secret | Description | Required |
|--------|-------------|----------|
| `GPG_PRIVATE_KEY` | GPG private key for signing commits | Yes |
| `GPG_KEY_ID` | GPG key ID for signing | Yes |
| `GPG_EMAIL` | Email associated with GPG key | Yes |
| `GPG_NAME` | Name associated with GPG key | Yes |
| `GITHUB_TOKEN` | GitHub token for pushing changes | Yes |

## Behavior

1. **On PR Open/Update**: The workflow checks if a version bump is needed
2. **Version Comparison**: Compares current `package.json` version against the latest GitHub release or git tag
3. **Auto Bump**: If current version is not ahead, automatically bumps the patch version
4. **GPG Signed Commit**: Commits with message `chore: bump version to X.Y.Z [skip ci]`
5. **Push**: Pushes the commit back to the PR branch

## Requirements

Your service repository must:
- Have a `package.json` file with a valid `version` field
- Have a `package-lock.json` file
- Use Node.js/npm for dependency management
- Have GPG keys configured as repository secrets

## Example: Setting Up GPG Keys

```bash
# Generate a GPG key (if you don't have one)
gpg --full-generate-key

# Export the private key
gpg --armor --export-secret-key YOUR_KEY_ID > private-key.asc

# Get the key ID
gpg --list-secret-keys --keyid-format=long

# Add the contents of private-key.asc to your repository secret GPG_PRIVATE_KEY
# Add other values (key ID, email, name) to corresponding secrets
```

## Troubleshooting

- **GPG signing fails**: Ensure your GPG_PRIVATE_KEY is exported correctly with armor encoding
- **Version not bumping**: Check that your current version in package.json is not already ahead of the latest release
- **Push fails**: Verify GITHUB_TOKEN has write permissions for contents
