#!/usr/bin/env node
'use strict';
const {driveBoot,section,freshImage,readShots}=require('./lib/drive.js');let fail=0;function ok(n,x,e=''){console.log((x?'  ok   ':'  FAIL ')+n+(x?'':' '+e));if(!x)fail++;}
const {dir:tmp,image}=freshImage('os-sedit-');
const r=driveBoot([
 'printf "#include <stdio.h>\\nint main(void) {\\n  return 0;\\n}\\n" > /root/game.c',
 'printf "one\\ntwo\\n" > /root/other.c','printf "literal-colon\\n" > "/root/colon:name.c"',
 'sedit /root/game.c:3 &','wmctl wait label EDIT:0 12000','echo ==tree','wmctl tree','echo ==cut',
 'SID=$(wmctl list | grep "Source Editor$" | sed "s/[^0-9].*//")','wmctl key $SID 9 102 64','wmctl wait label "Find text:" 8000','echo ==findtree','wmctl tree','echo ==cut','wmctl click Cancel',
 // The waits on the error boxes are load-bearing: before the BN_CLICKED
 // dialog fix, settext's EN_CHANGE cancel-closed the dialog, Go clicked
 // nothing, and these legs' unchanged-document asserts passed vacuously.
 'wmctl key $SID 9 103 64','for i in $(seq 1 80); do wmctl tree | grep -q "Line, FILE:LINE, or one cc diagnostic:" && break; sleep 0.1; done','wmctl settext EDIT:1 "/root/missing.c:8"','wmctl click Go',"wmctl wait label \"Cannot open location '/root/missing.c': No such file or directory\" 8000",'wmctl click OK','echo ==after-missing','wmctl gettext EDIT:0','wmctl gettext msctls_statusbar32:0','echo ==cut',
 'wmctl key $SID 9 103 64','for i in $(seq 1 80); do wmctl tree | grep -q "Line, FILE:LINE, or one cc diagnostic:" && break; sleep 0.1; done','wmctl settext EDIT:1 "/root/other.c:9"','wmctl click Go','wmctl wait label "location line 9 exceeds 3" 8000','wmctl click OK','echo ==after-eof','wmctl gettext EDIT:0','wmctl gettext msctls_statusbar32:0','echo ==cut',
 'wmctl gettext msctls_statusbar32:0','wmctl settext EDIT:0 "int main(void) { return 1; }"','wmctl click Save',
 'for i in $(seq 1 40); do grep -q "return 1" /root/game.c && break; sleep 0.05; done','echo ==file','cat /root/game.c','echo ==cut',
 'echo ==assoc','grep -E "^(c|h|default.gui|default.term)" /usr/share/openwith','echo ==cut',
 'echo ==menu','test -x "/usr/share/menu/Development/Source Editor" && echo MENU_OK','echo ==cut',
 'sedit /root/missing-cli.c:8 &','wmctl wait win "Source Editor - Open" 8000 && wmctl click OK && echo CLI-MISSING-LOUD',
 'sedit /root/other.c:9 &','wmctl wait label "location line 9 exceeds 3" 8000 && wmctl click OK && echo CLI-EOF-LOUD',
 'sedit "/root/colon:name.c" &','for i in $(seq 1 120); do wmctl tree | grep -q "literal-colon" && { echo CLI-LITERAL-COLON; break; }; sleep 0.1; done',
 // #730: cross-file Ctrl+G on a dirty buffer prompts exactly as ID_OPEN does.
 // Cancel aborts wholly (buffer, caret, target untouched); No navigates and
 // deliberately drops the edits without saving; Yes saves, then navigates.
 // Same-file Ctrl+G replaces nothing and must never prompt, dirty or not.
 // Fresh single sedit so EDIT:n agent indexes are unambiguous; settext is
 // programmatic (clears the modify flag), the typed key is what dirties.
 'pkill sedit','wmctl wait nowin "/root/game.c - Source Editor" 8000','wmctl wait nowin "/root/colon:name.c - Source Editor" 8000',
 'printf "alpha\\nbravo\\ncharlie\\n" > /root/dest.c',
 'sedit /root/game.c &','wmctl wait win "/root/game.c - Source Editor" 12000',
 'SID=$(wmctl list | grep "Source Editor$" | sed "s/[^0-9].*//")',
 'wmctl settext EDIT:0 "DIRTYBASE"','wmctl key $SID 0 120','wmctl wait text EDIT:0 "xDIRTYBASE" 6000',
 'wmctl key $SID 9 103 64','for i in $(seq 1 80); do wmctl tree | grep -q "Line, FILE:LINE, or one cc diagnostic:" && break; sleep 0.1; done','wmctl settext EDIT:1 "/root/dest.c:2"','wmctl click Go',
 'wmctl wait label "Save changes?" 8000','wmctl click Cancel',
 'echo ==g-cancel','wmctl gettext EDIT:0','wmctl gettext msctls_statusbar32:0','echo ==cut',
 'wmctl key $SID 9 103 64','for i in $(seq 1 80); do wmctl tree | grep -q "Line, FILE:LINE, or one cc diagnostic:" && break; sleep 0.1; done','wmctl settext EDIT:1 "/root/dest.c:2"','wmctl click Go',
 'wmctl wait label "Save changes?" 8000','wmctl click No','wmctl wait text EDIT:0 "bravo" 8000',
 'echo ==g-no','wmctl gettext EDIT:0','wmctl gettext msctls_statusbar32:0','cat /root/game.c','echo ==cut',
 'wmctl settext EDIT:0 "YESBASE"','wmctl key $SID 0 121','wmctl wait text EDIT:0 "yYESBASE" 6000',
 'wmctl key $SID 9 103 64','for i in $(seq 1 80); do wmctl tree | grep -q "Line, FILE:LINE, or one cc diagnostic:" && break; sleep 0.1; done','wmctl settext EDIT:1 "/root/game.c:1"','wmctl click Go',
 'wmctl wait label "Save changes?" 8000','wmctl click Yes','wmctl wait text EDIT:0 "return 1" 8000',
 'echo ==g-yes','wmctl gettext EDIT:0','wmctl gettext msctls_statusbar32:0','cat /root/dest.c','echo ==cut',
 'wmctl settext EDIT:0 "SAMEBASE"','wmctl key $SID 0 122','wmctl wait text EDIT:0 "zSAMEBASE" 6000','wmctl key $SID 0 13',
 'wmctl key $SID 9 103 64','for i in $(seq 1 80); do wmctl tree | grep -q "Line, FILE:LINE, or one cc diagnostic:" && break; sleep 0.1; done','wmctl settext EDIT:1 "/root/game.c:2"','wmctl click Go',
 'wmctl wait text msctls_statusbar32:0 "Line 2" 8000','wmctl wait nolabel "Save changes?" 2000',
 'echo ==g-same','wmctl gettext EDIT:0','wmctl gettext msctls_statusbar32:0','echo ==cut',
 // #729: the chunked-scan wiring end to end. ~414 KB is past the 262144-byte
 // turn cap, so styled pixels can only appear through several posted
 // WM_RESTYLE turns, then publish + GEM_SETSTYLES + the styled paint.
 'pkill sedit','wmctl wait nowin "*/root/game.c - Source Editor" 8000',
 'awk \'BEGIN{for(i=0;i<18000;i++)print "int a" i " = 1; /* c */"}\' > /root/big.c',
 'sedit /root/big.c &','wmctl wait win "/root/big.c - Source Editor" 12000',
 'BID=$(wmctl list | grep "Source Editor$" | sed "s/[^0-9].*//")',
 // Publish has no external marker — a genuine no-marker settle (0171 rule):
 // the multi-turn scan of ~414 KB completes far inside this bound.
 'sleep 8',
 'wmctl shot $BID /root/sedit-big.png && echo BIG-SHOT-OK',
 'pkill sedit'
],{timeout:300000,maxBuffer:32*1024*1024,image});
const out=String(r.stdout);ok('sedit exits only after exercised boot',r.status===0,String(r.stderr));ok('stable editor and status controls',/class=EDIT id=100/.test(out)&&/class=msctls_statusbar32 id=101/.test(out));ok('CLI line navigation reports line 3',/Line 3/.test(out));const miss=(out.split('==after-missing\n')[1]||'').split('==cut')[0],eof=(out.split('==after-eof\n')[1]||'').split('==cut')[0];ok('Ctrl+G nonexistent path is loud and leaves document/caret atomic',miss.includes('return 0;')&&miss.includes('Line 3'),miss);ok('Ctrl+G beyond-EOF target leaves document/caret atomic',eof.includes('return 0;')&&eof.includes('Line 3'),eof);ok('CLI nonexistent and beyond-EOF locations are loud',out.includes('CLI-MISSING-LOUD')&&out.includes('CLI-EOF-LOUD'));ok('CLI existing literal-colon filename takes whole-path precedence',out.includes('CLI-LITERAL-COLON'));ok('edit and save changes bytes',/==file\nint main\(void\) \{ return 1; \}/.test(out));ok('c+h associations and defaults',/c\s+\/bin\/sedit/.test(out)&&/h\s+\/bin\/sedit/.test(out)&&/default\.gui\s+\/bin\/notepad/.test(out)&&/default\.term\s+vi/.test(out));ok('Development menu activation exists',/MENU_OK/.test(out));
// #730: the driveBoot wait gate already made the prompts loud (a missing
// "Save changes?" box times its wait out and fails the whole run); these
// asserts pin what each answer did to the buffer, the disk and the target.
const gc=section(out,'g-cancel'),gn=section(out,'g-no'),gy=section(out,'g-yes'),gs=section(out,'g-same');
ok('dirty cross-file Ctrl+G Cancel keeps buffer, caret and target',gc.includes('xDIRTYBASE')&&!gc.includes('alpha')&&gc.includes('Line 1')&&gc.includes('/root/game.c'),gc);
ok('dirty cross-file Ctrl+G No navigates and drops edits unsaved',gn.includes('alpha')&&gn.includes('Line 2')&&gn.includes('/root/dest.c')&&!gn.includes('xDIRTYBASE')&&gn.includes('return 1;'),gn);
ok('dirty cross-file Ctrl+G Yes saves then navigates',gy.includes('yYESBASE')&&gy.includes('return 1;')&&gy.includes('/root/game.c'),gy);
ok('same-file Ctrl+G never prompts and keeps the dirty buffer',/==g-same\nz\nSAMEBASE/.test(out)&&gs.includes('Line 2')&&gs.includes('/root/game.c'),gs);
// #729: styled pixels for the multi-turn file, read back out of the root
// image (#657). Tolerance covers freetype AA part-coverage; glyph cores sit
// on the exact styles.c colors — TYPE purple (95,0,111) for 'int', COMMENT
// green (0,100,0) for the trailing block comments.
ok('big-file shot taken',out.includes('BIG-SHOT-OK'));
if(out.includes('BIG-SHOT-OK')){const {big}=readShots(tmp,{big:'sedit-big.png'});
let cGreen=0,cPurple=0;
for(let i=0;i<big.rgba.length;i+=4){const R=big.rgba[i],G=big.rgba[i+1],B=big.rgba[i+2];
 if(R<=24&&Math.abs(G-100)<=24&&B<=24)cGreen++;
 if(Math.abs(R-95)<=24&&G<=24&&Math.abs(B-111)<=24)cPurple++;}
ok('chunked scan publishes styled pixels for a multi-turn file',cGreen>20&&cPurple>20,`green=${cGreen} purple=${cPurple}`);}
process.exit(fail?1:0);
