import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const files = new Map([['/', ['index.html','text/html']], ['/index.html',['index.html','text/html']], ['/styles.css',['styles.css','text/css']], ['/app.js',['app.js','text/javascript']]]);
const server = createServer(async (request,response)=> {
  const target=files.get(new URL(request.url,'http://127.0.0.1').pathname);
  if (!target || !['GET','HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
  try {
    const content=await readFile(join(root,target[0]));
    response.writeHead(200,{'Content-Type':`${target[1]}; charset=utf-8`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(500).end('Preview unavailable'); }
});
server.listen(4179,'127.0.0.1',()=>console.log('Design preview: http://127.0.0.1:4179'));
