'use strict';

function validateHost(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ? undefined
    : 'Enter an SSH config alias, such as pibox-dev (not user@host or host:port).';
}

function validatePath(value) {
  return typeof value === 'string' && value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value)
    ? undefined
    : 'Enter an absolute guest folder path, such as /workspace.';
}

function validateConnection(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim()) {
    return 'Each connection needs a non-empty name.';
  }
  return validateHost(value.host) || validatePath(value.path);
}

function remoteFolder(connection) {
  const error = validateConnection(connection);
  if (error) throw new Error(error);
  return {
    scheme: 'vscode-remote',
    authority: `ssh-remote+${connection.host}`,
    path: connection.path,
  };
}

module.exports = { validateHost, validatePath, validateConnection, remoteFolder };
