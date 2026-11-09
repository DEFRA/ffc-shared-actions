#!/usr/bin/env node

// Local SonarCloud Quality Gate check for FCP services.
// Usually run through a service's scripts/sonar wrapper, see the README.
// Always analyses in branch mode, so nothing is posted to the pull request.

const { execSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SONAR_ORG = process.env.SONAR_ORG || 'defra'
const SONAR_HOST = process.env.SONAR_HOST_URL || 'https://sonarcloud.io'
const SONAR_TOKEN = process.env.SONAR_TOKEN

const LCOV_PATH = 'test-output/lcov.info'
const LAST_TEST_RUN_PATH = 'test-output/.sonar-check.json'
const POLL_ATTEMPTS = 30
const POLL_INTERVAL_MS = 2000
const DEFAULT_COVERAGE_TARGET = 80
const COVERAGE_COLUMN_WIDTH = 8
const COUNT_COLUMN_WIDTH = 7
const ANSI = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 }
const ICON = { pass: '✔', fail: '✖', warn: '⚠', step: '›' }
const SETUP_HINT = 'Run ./setup in ffc-pay-core to add or replace your token.'

const HELP = `
  Usage: scripts/sonar [OPTION...]

  Runs the tests (scripts/test), submits a SonarCloud analysis for the
  current branch and prints the Quality Gate result. Branch mode only,
  nothing is posted to the pull request.

  The tests are skipped when no code has changed since they last passed,
  so rerunning with --files straight after scripts/test is quick.

  Needs SONAR_TOKEN exported, e.g. in ~/.bashrc. Generate one at
  ${SONAR_HOST}/account/security

  Options:
    -t, --run-tests    always run scripts/test, even if nothing has changed
    -s, --skip-tests   never run scripts/test, reuse ${LCOV_PATH} as it is
    -f, --files        list files with uncovered new code, worst first
    -h, --help         display this help text
        --after-tests  used by scripts/test after the tests pass

  Set NO_COLOR=1 to turn off colour.
`

const METRIC_LABELS = {
  new_coverage: 'Coverage on New Code',
  new_duplicated_lines_density: 'Duplication on New Code',
  new_reliability_rating: 'Reliability Rating on New Code',
  new_security_rating: 'Security Rating on New Code',
  new_maintainability_rating: 'Maintainability Rating on New Code',
  new_blocker_violations: 'New Blocker Issues',
  new_critical_violations: 'New Critical Issues',
  new_major_violations: 'New Major Issues',
  new_security_hotspots_reviewed: 'Security Hotspots Reviewed on New Code'
}

const useColour = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (text) => useColour ? `\x1b[${code}m${text}\x1b[0m` : String(text)
const green = paint(ANSI.green)
const red = paint(ANSI.red)
const yellow = paint(ANSI.yellow)
const bold = paint(ANSI.bold)
const dim = paint(ANSI.dim)
const cyan = paint(ANSI.cyan)

// An error with an optional line telling the dev what to do about it
class CheckError extends Error {
  constructor (message, hint) {
    super(message)
    this.hint = hint
  }
}

const step = (text) => console.log(cyan(`${ICON.step} ${text}`))
const warn = (text) => console.log(yellow(`${ICON.warn} ${text}`))

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
const percent = (value) => value === undefined ? 'n/a' : `${Number(value).toFixed(1)}%`
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function parseArgs (args) {
  const options = { runTests: false, skipTests: false, afterTests: false, showFiles: false, help: false }

  for (const arg of args) {
    if (arg === '-t' || arg === '--run-tests') {
      options.runTests = true
    } else if (arg === '-s' || arg === '--skip-tests') {
      options.skipTests = true
    } else if (arg === '--after-tests') {
      options.afterTests = true
    } else if (arg === '-f' || arg === '--files') {
      options.showFiles = true
    } else if (arg === '-h' || arg === '--help') {
      options.help = true
    } else {
      throw new CheckError(`Unknown option: ${arg}`, 'Run with --help to see the options.')
    }
  }

  if (options.runTests && options.skipTests) {
    throw new CheckError('Use either --run-tests or --skip-tests, not both.')
  }

  return options
}

function runTests (projectRoot) {
  // SONAR_SKIP_AUTOCHECK stops scripts/test calling back into this check when it finishes
  const result = spawnSync('sh', [path.join(projectRoot, 'scripts/test')], {
    stdio: 'inherit',
    env: { ...process.env, SONAR_SKIP_AUTOCHECK: 'true' }
  })

  if (result.status !== 0) {
    throw new CheckError('Tests failed, so the Sonar check did not run.', 'Fix the failing tests above, then run it again.')
  }
}

// A git tree hash of the working tree, including uncommitted and new files but not ignored ones.
// Built in a copy of the index so the dev's staged changes are left alone.
function codeFingerprint () {
  const tempIndex = path.join(os.tmpdir(), `sonar-check-index-${process.pid}`)
  const gitIndex = execSync('git rev-parse --git-path index', { encoding: 'utf8' }).trim()

  try {
    if (fs.existsSync(gitIndex)) {
      fs.copyFileSync(gitIndex, tempIndex)
    }
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex }
    execSync('git add --all', { env, stdio: 'ignore' })
    return execSync('git write-tree', { env, encoding: 'utf8' }).trim()
  } finally {
    fs.rmSync(tempIndex, { force: true })
  }
}

function readLastTestRun () {
  try {
    return JSON.parse(fs.readFileSync(LAST_TEST_RUN_PATH, 'utf8'))
  } catch {
    return undefined
  }
}

function recordTestRun (fingerprint) {
  const lastTestRun = { fingerprint, testedAt: Date.now(), lcovModifiedAt: fs.statSync(LCOV_PATH).mtimeMs }
  fs.writeFileSync(LAST_TEST_RUN_PATH, JSON.stringify(lastTestRun, null, 2))
}

// Coverage can be reused when the code matches the last passing run and nothing has rewritten lcov.info since
function isCoverageUpToDate (lastTestRun, fingerprint) {
  return lastTestRun?.fingerprint === fingerprint &&
    fs.existsSync(LCOV_PATH) &&
    fs.statSync(LCOV_PATH).mtimeMs === lastTestRun.lcovModifiedAt
}

function timeAgo (timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]]

  for (const [unit, size] of units) {
    if (seconds >= size) {
      return `${plural(Math.floor(seconds / size), unit)} ago`
    }
  }

  return `${plural(seconds, 'second')} ago`
}

function prepareCoverage (options, projectRoot) {
  const fingerprint = codeFingerprint()
  const lastTestRun = readLastTestRun()

  if (options.afterTests) {
    recordTestRun(fingerprint)
    return
  }

  if (!options.runTests && isCoverageUpToDate(lastTestRun, fingerprint)) {
    console.log(green(`${ICON.pass} No code changes since the tests passed ${timeAgo(lastTestRun.testedAt)}, reusing their coverage.`))
    console.log(dim('Use --run-tests to run them anyway.'))
    return
  }

  if (options.skipTests) {
    if (!fs.existsSync(LCOV_PATH)) {
      throw new CheckError(`No ${LCOV_PATH} found.`, 'Run without --skip-tests first so the tests produce coverage.')
    }
    const warning = lastTestRun
      ? `code has changed since the tests passed ${timeAgo(lastTestRun.testedAt)}`
      : `can't tell if ${LCOV_PATH} matches the current code`
    warn(`Warning: ${warning}, coverage may be out of date.`)
    return
  }

  runTests(projectRoot)
  recordTestRun(fingerprint)
}

// Runs the scanner with its output hidden unless it fails, and returns the report-task.txt values
function scan (projectKey, branch) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-check-'))

  try {
    const result = spawnSync('npx', [
      '--yes', '@sonar/scan',
      `-Dsonar.host.url=${SONAR_HOST}`,
      `-Dsonar.organization=${SONAR_ORG}`,
      `-Dsonar.projectKey=${projectKey}`,
      `-Dsonar.branch.name=${branch}`,
      `-Dsonar.working.directory=${workDir}`
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

    if (result.status !== 0) {
      console.log(result.stdout, result.stderr)
      throw new CheckError('Sonar scan failed.', 'The scanner output is above.')
    }

    const report = fs.readFileSync(path.join(workDir, 'report-task.txt'), 'utf8')
    return Object.fromEntries(report.trim().split('\n').map(line => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

async function sonarApi (endpoint, params) {
  const url = `${SONAR_HOST}/api/${endpoint}?${new URLSearchParams(params)}`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${SONAR_TOKEN}` } })

  if (response.status === 401) {
    throw new CheckError('SonarCloud rejected SONAR_TOKEN (401). It may be wrong, expired or revoked.',
      `Generate a new one at ${SONAR_HOST}/account/security. ${SETUP_HINT}`)
  }
  if (response.status === 403) {
    throw new CheckError(`Your SonarCloud account can't access this project (403).`,
      `Ask a lead to add you to the ${SONAR_ORG} organisation.`)
  }
  if (!response.ok) {
    throw new CheckError(`SonarCloud returned ${response.status} from ${url}`, 'Try again in a minute, SonarCloud may be having problems.')
  }

  return response.json()
}

async function waitForAnalysis (taskId) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const { task } = await sonarApi('ce/task', { id: taskId })

    if (task.status === 'SUCCESS') {
      return
    }
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      throw new CheckError(`Sonar analysis ${task.status.toLowerCase()}.`, 'Check the background tasks for the project on SonarCloud.')
    }

    await sleep(POLL_INTERVAL_MS)
  }

  throw new CheckError('Timed out waiting for SonarCloud to process the analysis.', 'SonarCloud is busy. Retry with --skip-tests to skip rerunning the tests.')
}

// New code values come back under period (newer API) or periods (older API)
function toMetricMap (measures) {
  return Object.fromEntries(measures.map(measure => {
    const value = measure.period?.value ?? measure.periods?.[0]?.value ?? measure.value
    return [measure.metric, value]
  }))
}

async function getResults (projectKey, branch) {
  const newIssues = { componentKeys: projectKey, branch, inNewCodePeriod: true, ps: 1 }

  const [gate, measures, openIssues, acceptedIssues] = await Promise.all([
    sonarApi('qualitygates/project_status', { projectKey, branch }),
    sonarApi('measures/component', {
      component: projectKey,
      branch,
      metricKeys: 'new_coverage,new_duplicated_lines_density,new_security_hotspots'
    }),
    sonarApi('issues/search', { ...newIssues, resolved: false }),
    sonarApi('issues/search', { ...newIssues, issueStatuses: 'ACCEPTED' })
  ])

  return {
    passed: gate.projectStatus.status === 'OK',
    conditions: gate.projectStatus.conditions || [],
    metrics: toMetricMap(measures.component.measures),
    newIssues: openIssues.total,
    acceptedIssues: acceptedIssues.total
  }
}

async function getUncoveredFiles (projectKey, branch) {
  const tree = await sonarApi('measures/component_tree', {
    component: projectKey,
    branch,
    qualifiers: 'FIL',
    strategy: 'leaves',
    ps: 500,
    metricKeys: 'new_coverage,new_uncovered_lines,new_uncovered_conditions'
  })

  return tree.components
    .map(component => {
      const metrics = toMetricMap(component.measures)
      return {
        path: component.path,
        coverage: Number(metrics.new_coverage),
        lines: Number(metrics.new_uncovered_lines || 0),
        conditions: Number(metrics.new_uncovered_conditions || 0)
      }
    })
    .filter(file => file.lines + file.conditions > 0)
    .sort((a, b) => (b.lines + b.conditions) - (a.lines + a.conditions) || a.coverage - b.coverage)
}

function printSummary ({ passed, conditions, metrics, newIssues, acceptedIssues }) {
  // A measure is red when the gate fails on it, green otherwise
  const gateColour = (metric) => conditions.some(c => c.metricKey === metric && c.status === 'ERROR') ? red : green
  const hotspots = Number(metrics.new_security_hotspots || 0)

  console.log('')
  console.log(bold(passed ? green(`${ICON.pass} Quality Gate Passed`) : red(`${ICON.fail} Quality Gate Failed`)))
  console.log('')
  console.log(bold('Issues'))
  console.log(`  ${(newIssues > 0 ? yellow : green)(plural(newIssues, 'New issue'))}`)
  console.log(`  ${plural(acceptedIssues, 'Accepted issue')}`)
  console.log('')
  console.log(bold('Measures'))
  console.log(`  ${(hotspots > 0 ? yellow : green)(plural(hotspots, 'Security Hotspot'))}`)
  console.log(`  ${gateColour('new_coverage')(percent(metrics.new_coverage))} Coverage on New Code`)
  console.log(`  ${gateColour('new_duplicated_lines_density')(percent(metrics.new_duplicated_lines_density))} Duplication on New Code`)

  if (!passed) {
    console.log('')
    console.log(bold(red(`${ICON.fail} Failed conditions`)))
    for (const condition of conditions.filter(c => c.status === 'ERROR')) {
      const label = METRIC_LABELS[condition.metricKey] || condition.metricKey
      const required = `${condition.comparator === 'LT' ? '>=' : '<='} ${condition.errorThreshold}`
      const actual = `${label}: ${condition.actualValue}`
      console.log(`  ${red(actual)} (required ${required})`)
    }
  }
}

function printFiles (files, coverageTarget) {
  console.log('')
  console.log(bold('Files with uncovered new code'))

  if (files.length === 0) {
    console.log(`  ${green(`${ICON.pass} None, all new code is covered`)}`)
    return
  }

  console.log(dim('  Coverage  Lines  Conds  File'))
  for (const file of files) {
    const coverage = percent(file.coverage).padStart(COVERAGE_COLUMN_WIDTH)
    const lines = String(file.lines).padStart(COUNT_COLUMN_WIDTH)
    const conditions = String(file.conditions).padStart(COUNT_COLUMN_WIDTH)
    const colour = file.coverage >= coverageTarget ? yellow : red
    console.log(`  ${colour(coverage)}${lines}${conditions}  ${file.path}`)
  }
  console.log(dim('  Lines = uncovered new lines, Conds = uncovered new branches'))
}

async function main () {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(HELP)
    return 0
  }

  if (!SONAR_TOKEN) {
    warn('SONAR_TOKEN is not set, so the Sonar check can\'t run.')
    console.log(dim(`  Generate a token at ${SONAR_HOST}/account/security, then ${SETUP_HINT.charAt(0).toLowerCase()}${SETUP_HINT.slice(1)}`))
    console.log(dim('  Already set it? Open a new terminal so your shell picks it up.'))
    return 1
  }

  const projectRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  process.chdir(projectRoot)

  const projectKey = require(path.join(projectRoot, 'package.json')).name
  const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim()

  prepareCoverage(options, projectRoot)

  step(`Submitting Sonar analysis for ${projectKey} (branch: ${branch})...`)
  const report = scan(projectKey, branch)
  step('Waiting for SonarCloud to process it...')
  await waitForAnalysis(report.ceTaskId)

  const results = await getResults(projectKey, branch)
  printSummary(results)

  if (options.showFiles) {
    const coverageCondition = results.conditions.find(c => c.metricKey === 'new_coverage')
    printFiles(await getUncoveredFiles(projectKey, branch), Number(coverageCondition?.errorThreshold ?? DEFAULT_COVERAGE_TARGET))
  } else if (!results.passed) {
    console.log('')
    console.log(dim('Run with --files to see which files are missing coverage'))
  }

  console.log('')
  console.log(`${dim('See analysis details on SonarQube Cloud:')} ${cyan(report.dashboardUrl)}`)

  return results.passed ? 0 : 1
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('')
    console.error(bold(red(`${ICON.fail} ${err.message}`)))
    if (err.hint) {
      console.error(dim(`  ${err.hint}`))
    }
    process.exit(1)
  })
