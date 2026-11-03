// Match only canonical GitHub endpoints; no URL normalization or network redirects are followed.
const OFFICIAL_OWNER = 'jsgh1';
const OFFICIAL_REPOSITORIES = new Set([
  'SRD-Docker-Infra',
  'SRD-Backend',
  'SRD-Frontend',
  'SRD-Database',
  'SRD-Docs',
]);

export function isOfficialGithubOrigin(remote, repository) {
  if (typeof remote !== 'string' || !OFFICIAL_REPOSITORIES.has(repository)) return false;

  const path = OFFICIAL_OWNER + '/' + repository;
  const httpsOrigins = [
    'https://github.com/' + path,
    'https://github.com/' + path + '.git',
  ];
  const sshOrigins = [
    'git@github.com:' + path,
    'git@github.com:' + path + '.git',
  ];
  if (httpsOrigins.includes(remote) || sshOrigins.includes(remote)) return true;

  return false;
}

export function assertOfficialGithubOrigin(remote, repository) {
  if (!isOfficialGithubOrigin(remote, repository)) {
    throw new Error('Unexpected origin for ' + repository);
  }
  return true;
}
