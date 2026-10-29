'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { githubTarget, GitHubConnection } = require('../src/github-connection.cjs');
const url = 'https://github.com/example-user/example-project.git';
const payload = { projectPath: 'C:/project', remote: 'origin', url };
function fixture({ actualUrl = url, login = async () => {} } = {}) {
  const opened = [], calls = [];
  const service = { async execute(action) { calls.push(action); return action === 'remotes' ? { items: [{ name: 'origin', url: actualUrl }] } : {}; } };
  return { client: new GitHubConnection({ service, openExternal: async target => opened.push(target), login }), opened, calls };
}
test('仅允许标准 GitHub 地址，阻止凭据、外站及参数注入', () => {
  for (const value of [url, 'git@github.com:example-user/example-project.git', 'ssh://git@github.com/example-user/example-project.git']) assert.equal(githubTarget(value).webUrl, 'https://github.com/example-user/example-project');
  for (const value of ['https://github.com.evil.test/a/b', 'https://github.com@evil.test/a/b', 'https://user:password@github.com/a/b', 'https://github.com/a/b?token=x', 'https://github.com/a/b#x', 'file:///a/b', 'https://github.com:123/a/b', 'https://github.com/a/..', 'git@evil.test:a/b']) assert.throws(() => githubTarget(value));
});
test('打开远程前重新检查实际配置，地址变更不打开网页', async () => {
  const { client, opened } = fixture({ actualUrl: 'https://github.com/another/repo.git' });
  await assert.rejects(client.execute('githubOpenRepository', payload), /地址已变化/); assert.deepEqual(opened, []);
});
test('打开的是已登记仓库的固定 HTTPS 网页和新建页', async () => {
  const { client, opened, calls } = fixture();
  await client.execute('githubOpenRepository', payload); await client.execute('githubOpenNew', payload);
  assert.deepEqual(opened, ['https://github.com/example-user/example-project', 'https://github.com/new']); assert.ok(calls.includes('state'));
});
test('登录只运行固定 GCM 命令，不把远程参数当作命令', async () => {
  let args; const { client } = fixture({ login: async value => { args = value; return 'private provider output'; } });
  assert.deepEqual(await client.execute('githubLogin', { ...payload, command: 'bad' }), { authenticated: true });
  assert.deepEqual(args, ['credential-manager', 'github', 'login', '--browser', '--no-ui']);
});
test('SSH 仓库不启动 HTTPS 凭据流程', async () => {
  let count = 0; const actualUrl = 'git@github.com:example-user/example-project.git';
  const { client } = fixture({ actualUrl, login: async () => count++ });
  await assert.rejects(client.execute('githubLogin', { ...payload, url: actualUrl }), /SSH/); assert.equal(count, 0);
});
test('拒绝重复登录，结束后释放锁', async () => {
  let release; const { client } = fixture({ login: () => new Promise(resolve => { release = resolve; }) });
  const first = client.execute('githubLogin', payload);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.execute('githubLogin', payload), /正在等待/); release(); await first; assert.equal(client.loggingIn, false);
});
test('取消或缺少 GCM 时显示可操作提示，不回传供应商私密输出', async () => {
  const { client } = fixture({ login: async () => { throw new Error('secret-provider-output'); } });
  await assert.rejects(client.execute('githubLogin', payload), error => /Git Credential Manager/.test(error.message) && !/secret/.test(error.message));
  assert.equal(client.loggingIn, false);
});
