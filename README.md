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