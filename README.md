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
