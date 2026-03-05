# ffc-shared-actions

A collection of shared actions for use in GitHub workflows across the FFC repositories.
Structure for GitHub actions is for actions to reside in the .github/workflows directory of the repository.

## Usage
To use an action from this repository in your workflow, you can reference it in the consuming service


## Workflows

secret-scanner.yml - A workflow that scans for secrets in the codebase using the GitHub Secret Scanning feature. This workflow is triggered on push and pull request events, and it helps to identify and prevent the exposure of sensitive information in the codebase.
This relies on a configuration file named gitleaks.toml which is located in the repository root.

The gitleaks.toml file contains the configuration for the secret scanning process, including rules for identifying secrets, exclusions, and other settings. It is used by the secret-scanner.yml workflow to perform the scanning effectively. In the consuming service, a gitleaks.toml file can also be created in the root directory to provide specific rules and configurations for that service, allowing for customization of the secret scanning process based on the needs of the service.