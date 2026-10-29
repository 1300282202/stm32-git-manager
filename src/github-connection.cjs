'use strict';

const GITHUB_ACTIONS = ['githubOpenNew', 'githubOpenRepository', 'githubLogin'];

function githubTarget(value) {
  if (typeof value !== 'string') throw new Error('请选择有效的 GitHub 远程仓库。');
  let owner, repository, https = false;
  const scp = /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(value);
  if (scp) [, owner, repository] = scp;
  else {
    let url;
    try { url = new URL(value); } catch { throw new Error('这不是支持的 GitHub 仓库地址。'); }
    const parts = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    https = url.protocol === 'https:';
    if (url.hostname !== 'github.com' || url.port || url.password || url.search || url.hash ||
      (!https && url.protocol !== 'ssh:') || (https && url.username) ||
      (!https && url.username !== 'git') || !parts) throw new Error('只允许标准的 github.com HTTPS 或 SSH 仓库地址。');
    [, owner, repository] = parts;
  }
  if (['.', '..'].includes(repository)) throw new Error('GitHub 仓库名称无效。');
  return { owner, repository, https, webUrl: `https://github.com/${owner}/${repository}` };
}

class GitHubConnection {
  constructor({ service, openExternal, login }) {
    this.service = service; this.openExternal = openExternal; this.login = login; this.loggingIn = false;
  }
  async execute(action, payload) {
    if (!GITHUB_ACTIONS.includes(action)) throw new Error('未支持的 GitHub 操作。');
    await this.service.execute('state', { projectPath: payload.projectPath });
    if (action === 'githubOpenNew') {
      await this.openExternal('https://github.com/new'); return { opened: true };
    }
    const remotes = await this.service.execute('remotes', { projectPath: payload.projectPath });
    const remote = remotes.items.find(item => item.name === payload.remote);
    if (!remote || !payload.url || remote.url !== payload.url) throw new Error('远程地址已变化，请刷新后重试。');
    const target = githubTarget(remote.url);
    if (action === 'githubOpenRepository') {
      await this.openExternal(target.webUrl); return { opened: true };
    }
    if (!target.https) throw new Error('GitHub 网页登录用于 HTTPS 同步；SSH 地址请使用已有 SSH 密钥，或先改为 HTTPS 地址。');
    if (this.loggingIn) throw new Error('正在等待 GitHub 登录，请先完成浏览器中的操作。');
    this.loggingIn = true;
    try {
      // GCM owns OAuth and the Windows credential store. No token enters our app data or renderer.
      await this.login(['credential-manager', 'github', 'login', '--browser', '--no-ui']);
      return { authenticated: true };
    } catch {
      throw new Error('GitHub 登录未完成。请确认 Git for Windows 包含 Git Credential Manager，并在浏览器完成登录；取消或超时后可重试。');
    } finally { this.loggingIn = false; }
  }
}

module.exports = { GITHUB_ACTIONS, githubTarget, GitHubConnection };
