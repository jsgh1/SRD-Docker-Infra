import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { assertProvenanceMatches, sourceShaEnvironment, validateSourceShas } from './validate-source-shas.mjs';

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
      remote: `https://github.com/jsgh1/${repository}.git`,
    };
  }
  return { sources };
}

test('accepts only full immutable revisions for all four component repositories', () => {
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

test('accepts provenance only when all five repositories match the pinned clean origins', () => {
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
  wrongRemote.sources['SRD-Database'].remote = 'https://github.com/other/SRD-Database.git';
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

test('keeps workflow defaults, checkout fallbacks, and guards on the same P36 cut', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/d8-cross-repo.yml', import.meta.url), 'utf8');
  const approved = [
    'df312f375159cd730e18c02027ec55efd767401f',
    '158dcae1957d1b37025fcec137ada0b7b9f17984',
    'a96fc6e40e18c19adb6588362f53fb0c8bce5e33',
    '90675bed64469dd17157fa224cbb6fcc833a382c',
  ];
  for (const revision of approved) {
    assert.equal((workflow.match(new RegExp(revision, 'g')) ?? []).length, 4, `${revision} must be consistent across the input, both validations, and checkout`);
  }
});

test('uses the same approved Backend cut in the required clean Reverb image check', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/migration-compose-validation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /repository: jsgh1\/SRD-Backend[\s\S]*?ref: df312f375159cd730e18c02027ec55efd767401f[\s\S]*?path: _backend/);
  assert.doesNotMatch(workflow, /ref: fd5e0add40643543e9dd6b80f8da3ee10b4aea52/);
});
