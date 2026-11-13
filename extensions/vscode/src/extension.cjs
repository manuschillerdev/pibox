'use strict';

const { validateHost, validatePath, validateConnection, remoteFolder } = require('./connections.cjs');

function activate(context) {
  const vscode = require('vscode');
  const config = () => vscode.workspace.getConfiguration('pibox.ssh');
  const connections = () => {
    const values = config().get('connections', []);
    if (!Array.isArray(values)) throw new Error('pibox.ssh.connections must be an array.');
    for (const value of values) {
      const error = validateConnection(value);
      if (error) throw new Error(`Invalid pibox.ssh.connections setting: ${error}`);
    }
    return values;
  };

  async function addConnection() {
    const host = await vscode.window.showInputBox({
      title: 'Pibox SSH connection',
      prompt: 'Host alias configured in your local SSH config',
      placeHolder: 'pibox-dev',
      validateInput: validateHost,
      ignoreFocusOut: true,
    });
    if (host === undefined) return;
    const path = await vscode.window.showInputBox({
      title: 'Pibox workspace folder',
      prompt: 'Absolute folder path inside the running Pibox guest',
      value: '/workspace',
      validateInput: validatePath,
      ignoreFocusOut: true,
    });
    if (path === undefined) return;
    const name = await vscode.window.showInputBox({
      title: 'Pibox connection name',
      value: host,
      validateInput: value => value.trim() ? undefined : 'Enter a connection name.',
      ignoreFocusOut: true,
    });
    if (name === undefined) return;
    const connection = { name: name.trim(), host, path };
    const values = connections();
    if (values.some(value => value.name === connection.name)) {
      throw new Error(`A connection named "${connection.name}" already exists. Edit pibox.ssh.connections in User Settings to change it.`);
    }
    await config().update('connections', [...values, connection], vscode.ConfigurationTarget.Global);
    return connection;
  }

  async function connect() {
    const values = connections();
    let connection;
    if (values.length === 0) {
      connection = await addConnection();
    } else {
      const add = { label: '$(add) Add SSH connection…' };
      const selected = await vscode.window.showQuickPick([
        ...values.map(value => ({
          label: value.name,
          description: value.host,
          detail: value.path,
          connection: value,
        })),
        add,
      ], { title: 'Connect to a Pibox workspace', matchOnDescription: true, matchOnDetail: true });
      if (!selected) return;
      connection = selected === add ? await addConnection() : selected.connection;
    }
    if (!connection) return;
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from(remoteFolder(connection)), {
      forceNewWindow: true,
    });
  }

  const register = (id, handler) => context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
    try {
      await handler();
    } catch (error) {
      await vscode.window.showErrorMessage(`Pibox SSH: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  register('pibox.connect', connect);
  register('pibox.addConnection', addConnection);
}

module.exports = { activate };
