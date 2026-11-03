import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceShaEnvironment = Object.freeze({
  'SRD-Backend': 'BACKEND_SHA',
  'SRD-Frontend': 'FRONTEND_SHA',
  'SRD-Database': 'DATABASE_SHA',
  'SRD-Docs': 'DOCS_SHA',
});

const shaPattern = /^[0-9a-f]{40}$/;

export function validateSourceShas(environment) {
  const revisions = {};
  for (const [repository, variable] of Object.entries(sourceShaEnvironment)) {
    const value = environment[variable];
    if (typeof value !== 'string' || !shaPattern.test(value)) {
      throw new Error(`${repository} must be pinned to an exact 40-character commit SHA (${variable}).`);
    }
    revisions[repository] = value;
  }
  return revisions;
}

export function assertProvenanceMatches(provenance, expected, expectedInfraSha) {
  if (!shaPattern.test(expectedInfraSha ?? '')) {
    throw new Error('Infra must be pinned to the exact workflow commit SHA.');
  }

  const revisions = { 'SRD-Docker-Infra': expectedInfraSha, ...expected };
  for (const [repository, revision] of Object.entries(revisions)) {
    const source = provenance?.sources?.[repository];
    if (!source || source.sha !== revision) {
      throw new Error(`Assembled provenance does not match the approved SHA for ${repository}.`);
    }
    if (source.dirty !== false) {
      throw new Error(`Assembled source is not clean: ${repository}.`);
    }
    if (!new RegExp(`(?:/|:)jsgh1/${repository}(?:\\.git)?$`, 'i').test(source.remote ?? '')) {
      throw new Error(`Unexpected source repository identity: ${repository}.`);
    }
  }
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const expected = validateSourceShas(process.env);
  if (process.argv[2] === '--check-provenance') {
    const manifestPath = process.argv[3];
    if (!manifestPath) throw new Error('Usage: validate-source-shas.mjs --check-provenance <manifest.json>');
    const provenance = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assertProvenanceMatches(provenance, expected, process.env.INFRA_SHA);
    console.log(JSON.stringify({ status: 'provenance-matches-pinned-sources', sources: expected, infra: process.env.INFRA_SHA }));
  } else if (process.argv.length > 2) {
    throw new Error('Usage: validate-source-shas.mjs [--check-provenance <manifest.json>]');
  } else {
    console.log(JSON.stringify({ status: 'valid-immutable-source-revisions', sources: expected }));
  }
}
