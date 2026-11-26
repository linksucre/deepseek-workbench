import { readFile } from 'node:fs/promises'

const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

export async function mountWorkbenchPage(ctx) {
  for (const [path, file, type] of [
    ['/workbench', 'index.html', 'text/html; charset=utf-8'],
    ['/workbench/ui.css', 'ui.css', 'text/css; charset=utf-8'],
    ['/workbench/ui.mjs', 'ui.mjs', 'text/javascript; charset=utf-8'],
    ['/workbench/context-link.mjs', '../domain/context-link.mjs', 'text/javascript; charset=utf-8'],
  ]) {
    const body = await readFile(new URL(file, import.meta.url))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path, auth: 'required',
      resource: async (_request, peer) => peer?.principal.kind === 'owner'
        ? new Response(body, { headers: { 'content-type': type, 'content-security-policy': policy,
          'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
        : new Response('forbidden', { status: 403 }),
    }))
  }
  for (const path of ['/workbench/v2/workspaces', '/workbench/v1/workspaces']) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path, auth: 'required',
      resource: async (_request, peer) => peer?.principal.kind === 'owner'
        ? Response.json(ctx.workspaceRegistry.list().map(({ id, title, path }) => ({ id, title, path })),
          { headers: { 'cache-control': 'no-store' } })
        : new Response('forbidden', { status: 403 }),
    }))
  }
}
