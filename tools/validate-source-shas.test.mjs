import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertProvenanceMatches, sourceShaEnvironment, validateSourceShas } from './validate-source-shas.mjs';
import { assertOfficialGithubOrigin, isOfficialGithubOrigin } from './github-origin.mjs';

const repositoryNames = [
  'SRD-Docker-Infra',
  'SRD-Backend',
  'SRD-Frontend',
  'SRD-Database',
  'SRD-Docs',
];

const environment = {
  BACKEND_SHA: '1'.repeat(40),
  FRONTEND_SHA: '2'.repeat(40),
  DATABASE_SHA: '3'.repeat(40),
  DOCS_SHA: '4'.repeat(40),
};

function createProvenance() {
  const sources = {
    'SRD-Docker-Infra': {
      sha: '5'.repeat(40),
      dirty: false,
      remote: 'https://github.com/jsgh1/SRD-Docker-Infra.git',
    },
  };
  for (const [repository, variable] of Object.entries(sourceShaEnvironment)) {
    sources[repository] = {
      sha: environment[variable],
      dirty: false,
      remote: 'https://github.com/jsgh1/' + repository + '.git',
    };
  }
  return { sources };
}

function createSyntheticSources(tempRoot, backendOrigin) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'srd-p38-git-origin-'));
  const files = {
    'SRD-Docker-Infra': ['compose.yaml', 'docker/php.Dockerfile'],
    'SRD-Backend': ['services/identity/artisan', 'packages/php/README.md', 'contracts/README.md'],
    'SRD-Frontend': ['apps/web/package.json'],
    'SRD-Database': ['database/03_dcl/01_grants/initialize-services.sh', 'services/README.md'],
    'SRD-Docs': ['Entregables/PDF/README.md'],
  };
  const sources = {};
  for (const repository of repositoryNames) {
    const directory = path.join(root, repository);
    fs.mkdirSync(directory, { recursive: true });
    for (const relative of files[repository]) {
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, relative.endsWith('.json') ? '{"private":true}\n' : 'synthetic origin test\n');
    }
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    const remote = repository === 'SRD-Backend' && backendOrigin
      ? backendOrigin
      : (repository === 'SRD-Docker-Infra' ? 'git@github.com:jsgh1/' + repository + '.git' : 'https://github.com/jsgh1/' + repository + '.git');
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: directory });
    execFileSync('git', ['add', '-A'], { cwd: directory });
    execFileSync('git', ['-c', 'user.name=SRD Origin Test', '-c', 'user.email=srd-origin-test@example.invalid', 'commit', '--quiet', '-m', 'synthetic origin test'], { cwd: directory });
    sources[repository] = directory;
  }
  return { root, sources };
}

function runAssemblerCheck(sources) {
  const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const assembler = path.join(repositoryRoot, 'tools', 'assemble-workspace.mjs');
  return spawnSync(process.execPath, [
    assembler,
    '--infra', sources['SRD-Docker-Infra'],
    '--backend', sources['SRD-Backend'],
    '--frontend', sources['SRD-Frontend'],
    '--database', sources['SRD-Database'],
    '--docs', sources['SRD-Docs'],
    '--check',
  ], { encoding: 'utf8' });
}

function testTempRoot() {
  return process.env.P38_TEST_TEMP || os.tmpdir();
}

test('accepts full immutable revisions for all four component repositories', () => {
  assert.deepEqual(validateSourceShas(environment), {
    'SRD-Backend': environment.BACKEND_SHA,
    'SRD-Frontend': environment.FRONTEND_SHA,
    'SRD-Database': environment.DATABASE_SHA,
    'SRD-Docs': environment.DOCS_SHA,
  });
});

test('rejects missing, branch-like, abbreviated, and non-hex revisions', () => {
  for (const variable of Object.values(sourceShaEnvironment)) {
    for (const value of [undefined, '', 'dev', 'abc1234', 'g'.repeat(40)]) {
      assert.throws(() => validateSourceShas({ ...environment, [variable]: value }), /exact 40-character commit SHA/);
    }
  }
});

test('accepts provenance only when all five repositories match the pinned clean official origins', () => {
  assert.equal(assertProvenanceMatches(createProvenance(), validateSourceShas(environment), '5'.repeat(40)), true);
});

test('rejects a provenance SHA mismatch', () => {
  const provenance = createProvenance();
  provenance.sources['SRD-Frontend'].sha = 'f'.repeat(40);
  assert.throws(() => assertProvenanceMatches(provenance, validateSourceShas(environment), '5'.repeat(40)), /does not match the approved SHA/);
});

test('rejects an Infra provenance SHA that differs from the workflow revision', () => {
  assert.throws(() => assertProvenanceMatches(createProvenance(), validateSourceShas(environment), '6'.repeat(40)), /does not match the approved SHA/);
});

test('rejects dirty or unexpected source repositories in provenance', () => {
  const dirty = createProvenance();
  dirty.sources['SRD-Docs'].dirty = true;
  assert.throws(() => assertProvenanceMatches(dirty, validateSourceShas(environment), '5'.repeat(40)), /not clean/);

  const wrongRemote = createProvenance();
  wrongRemote.sources['SRD-Database'].remote = 'https://evil.example/jsgh1/SRD-Database.git';
  assert.throws(() => assertProvenanceMatches(wrongRemote, validateSourceShas(environment), '5'.repeat(40)), /Unexpected source repository identity/);
});

test('keeps integrated QA disabled and its preflight isolated', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/d8-cross-repo.yml', import.meta.url), 'utf8');
  assert.equal((workflow.match(/^    if: \$\{\{ false \}\}$/gm) ?? []).length, 1);
  assert.match(workflow, /run_integration:[\s\S]*?default: false/);
  assert.match(workflow, /docker ps -a --filter "label=com\.docker\.compose\.project=\$project/);
  assert.match(workflow, /docker volume ls --filter "name=\$project/);
  assert.match(workflow, /docker network ls --filter "name=\$project/);
  const artifactStart = workflow.indexOf('name: srd-integration-evidence');
  const artifactEnd = workflow.indexOf('if-no-files-found: ignore', artifactStart);
  assert.notEqual(artifactStart, -1);
  assert.notEqual(artifactEnd, -1);
  assert.doesNotMatch(workflow.slice(artifactStart, artifactEnd), /assembled\/(?:\.env|\.local\/e2e-fixture\.json)/);
});

test('keeps workflow defaults, checkout fallbacks, and guards on the P48 source cut', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/d8-cross-repo.yml', import.meta.url), 'utf8');
  const approved = [
    'd1f3052c3e734bc2357a45eada3ae32b04241877',
    '757af358ba0200f00646e95ab8a4eefbb75f62d1',
    'a96fc6e40e18c19adb6588362f53fb0c8bce5e33',
    '14317523566e27d46bbc152fc1627cf1807f77f4',
  ];
  for (const revision of approved) {
    assert.equal((workflow.match(new RegExp(revision, 'g')) ?? []).length, 4, revision + ' must be consistent across input, validations, and checkout');
  }
});

test('uses the P48 Backend cut in the required clean Reverb image check', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/migration-compose-validation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /repository: jsgh1\/SRD-Backend[\s\S]*?ref: d1f3052c3e734bc2357a45eada3ae32b04241877[\s\S]*?path: _backend/);
  assert.doesNotMatch(workflow, /ref: fd5e0add40643543e9dd6b80f8da3ee10b4aea52/);
});

test('accepts canonical HTTPS and SSH origins for each official repository only', () => {
  for (const repository of repositoryNames) {
    const sourcePath = 'jsgh1/' + repository;
    for (const origin of [
      'https://github.com/' + sourcePath,
      'https://github.com/' + sourcePath + '.git',
      'git@github.com:' + sourcePath,
      'git@github.com:' + sourcePath + '.git',
    ]) {
      assert.equal(isOfficialGithubOrigin(origin, repository), true, repository + ': ' + origin);
      assert.equal(assertOfficialGithubOrigin(origin, repository), true);
    }
  }
});

test('rejects hostile hosts, wrong owners, extra paths, and unexpected URL forms', () => {
  const badOrigins = [
    'https://evil.example/jsgh1/SRD-Backend.git',
    'https://github.com.evil.example/jsgh1/SRD-Backend',
    'https://github.com/other/SRD-Backend.git',
    'https://github.com/jsgh1/SRD-Backend/extra',
    'https://github.com/jsgh1/SRD-Frontend.git',
    'http://github.com/jsgh1/SRD-Backend.git',
    'ssh://git@github.com/jsgh1/SRD-Backend.git',
    'https://user@github.com/jsgh1/SRD-Backend.git',
    'https://github.com:8443/jsgh1/SRD-Backend.git',
    'https://github.com/jsgh1/SRD-Backend.git?redirect=evil.example',
    'https://github.com/jsgh1/SRD-Backend.git#fragment',
    'https://github.com/jsgh1/SRD-Backend.git/../SRD-Backend.git',
    'git@github.com.evil.example:jsgh1/SRD-Backend.git',
    '',
    undefined,
  ];
  for (const origin of badOrigins) {
    assert.equal(isOfficialGithubOrigin(origin, 'SRD-Backend'), false, String(origin));
    assert.throws(() => assertOfficialGithubOrigin(origin, 'SRD-Backend'), /Unexpected origin/);
  }
  assert.equal(isOfficialGithubOrigin('https://github.com/jsgh1/SRD-Backend.git', 'SRD-Other'), false);
});

test('the real assembler check accepts synthetic sources with official HTTPS and SSH origins', (t) => {
  const fixture = createSyntheticSources(testTempRoot());
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = runAssemblerCheck(fixture.sources);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'check');
});

test('the real assembler check rejects a lookalike hostile Git host', (t) => {
  const fixture = createSyntheticSources(testTempRoot(), 'https://evil.example/jsgh1/SRD-Backend.git');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = runAssemblerCheck(fixture.sources);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected origin for SRD-Backend/);
});
