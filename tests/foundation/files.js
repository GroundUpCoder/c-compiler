'use strict';
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../..');
const files={};
for(const name of fs.readdirSync(__dirname)) if(/\.(m|h)$/.test(name)) files['/tests/'+name]=fs.readFileSync(path.join(__dirname,name),'utf8');
for(const name of fs.readdirSync(path.join(root,'os/foundation'))) if(name.endsWith('.m')) files['/lib/'+name]=fs.readFileSync(path.join(root,'os/foundation',name),'utf8');
for(const name of fs.readdirSync(path.join(root,'os/foundation/Foundation'))) if(name.endsWith('.h')) files['/include/Foundation/'+name]=fs.readFileSync(path.join(root,'os/foundation/Foundation',name),'utf8');
module.exports=files;
