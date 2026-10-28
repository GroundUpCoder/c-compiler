const fs=require('fs'),path=require('path');
const root=JSON.parse(fs.readFileSync(path.join(__dirname,'run.json'))).root;
const h=require(path.join(root,'tests/lib/host-health.js')),sample=h.sample(),verdict=h.verdict(sample);
console.log(JSON.stringify({sample,verdict}));if(verdict.level==='refuse')process.exitCode=2;
