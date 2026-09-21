import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const routes={'/':'tools/availability-preview.html','/availability-preview.css':'tools/availability-preview.css','/availability-preview.js':'tools/availability-preview.js','/explora-ui.css':'explora-ui.css','/assets/explora-home-reference.png':'assets/explora-home-reference.png'};
http.createServer((req,res)=>{const file=routes[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png'})[path.extname(file)]);res.setHeader('Cache-Control','no-store');res.end(fs.readFileSync(path.join(root,file)));}).listen(8083,'127.0.0.1',()=>console.log('Vista visual: http://localhost:8083/'));
